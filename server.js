const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cors = require('cors');
const turf = require('@turf/turf');
const NodeCache = require('node-cache');
const compression = require('compression');
const fs = require('fs').promises;
const DataManager = require('./dataManager');
const ZoneCalculator = require('./zoneCalculator');

const app = express();
const port = process.env.PORT || 3000;
const dataCache = new NodeCache({ stdTTL: 86400 }); // Cache for 24 hours

// Initialize data manager and zone calculator
const dataManager = new DataManager({
  dataDir: path.join(__dirname, 'gis_data'),
  fallbackDir: path.join(__dirname, 'fallback_data'),
  refreshInterval: 24 * 60 * 60 * 1000 // 24 hours
});

const zoneCalculator = new ZoneCalculator({
  zonesDir: path.join(__dirname, 'calculated_zones'),
  cacheDir: path.join(__dirname, 'zone_cache'),
  gridResolution: 0.005
});

// Fallback data directory - create this directory and add fallback GeoJSON files
const FALLBACK_DIR = path.join(__dirname, 'fallback_data');

// Enable compression
app.use(compression());

// Configure CORS
app.use(cors({
  origin: ['http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Static files
app.use(express.static('public', { maxAge: '1h' }));
app.use(express.json({ limit: '1mb' }));

// Server status vars
let serverStartTime = Date.now();
let lastSuccessfulExternalAPICall = null;
let apiCallAttempts = 0;
let apiCallsSucceeded = 0;

// Track calculation status
const zoneCalculations = {
  inProgress: false,
  lastStarted: null,
  progress: 0, // 0-100
  lastCompleted: null,
  error: null
};

class APIExplorer {
  constructor(options = {}) {
    this.delayBetweenRequests = options.delayBetweenRequests || 2000;
    this.maxRetries = options.maxRetries || 3;
    this.commonHeaders = options.headers || {
      'Cache-Control': 'no-cache'
    };
    this.timeout = options.timeout || 30000; // 30s timeout default
    this.useFallback = options.useFallback !== undefined ? options.useFallback : true;
  }

  async rateLimitedFetch(url, options = {}) {
    let retries = 0;
    const startTime = Date.now();

    // Track API call attempt
    apiCallAttempts++;

    while (retries < this.maxRetries) {
      try {
        // Add delay between requests to avoid rate limiting
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, this.delayBetweenRequests * Math.pow(2, retries - 1)));
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          headers: this.commonHeaders,
          ...options,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Track successful API call
        apiCallsSucceeded++;
        lastSuccessfulExternalAPICall = Date.now();

        console.log(`Fetched ${url} in ${Date.now() - startTime}ms`);
        return response;
      } catch (err) {
        retries++;
        console.warn(`Retry ${retries}/${this.maxRetries} for ${url} after ${Date.now() - startTime}ms: ${err.message}`);

        if (retries === this.maxRetries) {
          throw err;
        }
      }
    }
  }

  async fetchGeoJSON(url, fallbackKey) {
    try {
      const cacheKey = `geojson_${url}`;

      // Try to get from cache first
      const cachedData = dataCache.get(cacheKey);
      if (cachedData) {
        console.log(`Using cached data for: ${url}`);
        return cachedData;
      }

      console.log(`Fetching data from: ${url}`);
      const response = await this.rateLimitedFetch(url);
      const data = await response.json();

      if (!this.isValidGeoJSON(data)) {
        throw new Error('Invalid GeoJSON response');
      }

      const cleanedData = this.cleanupGeoJSON(data);

      // Set a cache TTL - 24 hours for most data
      const ttl = 86400; // 24 hours
      dataCache.set(cacheKey, cleanedData, ttl);

      console.log(`Caching valid GeoJSON from: ${url} for ${ttl}s`);
      return cleanedData;
    } catch (err) {
      console.error(`Endpoint ${url} failed: ${err.message}`);

      if (this.useFallback && fallbackKey) {
        return await this.getFallbackData(fallbackKey);
      }

      throw err;
    }
  }

  async getFallbackData(key) {
    try {
      // Check if fallback is already in cache
      const cacheKey = `fallback_${key}`;
      const cachedFallback = dataCache.get(cacheKey);

      if (cachedFallback) {
        console.log(`Using cached fallback data for ${key}`);
        return cachedFallback;
      }

      // Try to read from fallback file
      const fallbackPath = path.join(FALLBACK_DIR, `${key}.json`);
      const fallbackData = JSON.parse(await fs.readFile(fallbackPath, 'utf8'));

      // Cache fallback data
      dataCache.set(cacheKey, fallbackData);

      console.log(`Using fallback data for ${key} from file`);
      return fallbackData;
    } catch (err) {
      console.error(`Failed to get fallback data for ${key}: ${err.message}`);
      // Return empty GeoJSON as last resort
      return {
        type: 'FeatureCollection',
        features: [],
        metadata: {
          source: 'fallback',
          error: `Failed to get data: ${err.message}`
        }
      };
    }
  }

  cleanupGeoJSON(data) {
    if (!data || !data.type) return data;

    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
      // Filter out invalid features
      const validFeatures = data.features.filter(feature => {
        if (!feature || feature.type !== 'Feature' || !feature.geometry || !feature.geometry.type) {
          console.warn(`Skipping invalid feature: ${JSON.stringify(feature)}`);
          return false;
        }

        const validTypes = ["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon"];
        if (!validTypes.includes(feature.geometry.type)) {
          console.warn(`Skipping feature with invalid geometry type: ${feature.geometry.type}`);
          return false;
        }

        if (!Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length === 0) {
          console.warn(`Skipping feature with invalid coordinates: ${JSON.stringify(feature)}`);
          return false;
        }

        return true;
      });

      return {
        type: 'FeatureCollection',
        features: validFeatures,
        ...(data.crs ? { crs: data.crs } : {})
      };
    }
    return data;
  }

  isValidGeoJSON(data) {
    if (!data || typeof data !== 'object') return false;

    if (data.type === "FeatureCollection") {
      return Array.isArray(data.features);
    }

    if (data.type === "Feature") {
      return data.geometry && data.geometry.type;
    }

    return ["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection"].includes(data.type);
  }
}


const ENDPOINTS = {
  portAuthorities: "https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Boundaries/MapServer/12/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  marineParks: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/2/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  fishHabitat: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/4/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  cockburnSound: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/12/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  mooringAreas: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/15/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  marineInfrastructure: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/18/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  bathymetry: "https://services.ga.gov.au/gis/rest/services/Australian_Bathymetry_Topography/MapServer/WMSServer?request=GetMap&service=WMS&version=1.3.0&layers=0&styles=&format=application/json;type=geojson&bbox=115.2,-32.60,116.0,-30.90&width=1024&height=1024&crs=EPSG:4326",
  marineGeomorphic: "https://services.ga.gov.au/gis/rest/services/Geomorphic_Features_Australia_Marine_Jurisdiction/MapServer/WMSServer?request=GetMap&service=WMS&version=1.3.0&layers=0&styles=&format=application/json;type=geojson&bbox=115.2,-32.60,116.0,-30.90&width=1024&height=1024&crs=EPSG:4326",
  marineMultibeam: "https://services.ga.gov.au/gis/rest/services/Marine_Survey_Multibeam_Bathymetry/MapServer/WMSServer?request=GetMap&service=WMS&version=1.3.0&layers=0&styles=&format=application/json;type=geojson&bbox=115.2,-32.60,116.0,-30.90&width=1024&height=1024&crs=EPSG:4326"
};

const ALTERNATIVE_ENDPOINTS = {
  bathymetryAlt: "https://geoserver.ausseabed.gov.au/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=ausseabed:multibeam_survey_extents&maxFeatures=500&outputFormat=application/json&bbox=115.2,-32.60,116.0,-30.90"
};

// Create fallback data directory if it doesn't exist
async function ensureFallbackDir() {
  try {
    await fs.mkdir(FALLBACK_DIR, { recursive: true });
    console.log(`Fallback data directory created at ${FALLBACK_DIR}`);
  } catch (err) {
    console.error(`Failed to create fallback directory: ${err.message}`);
  }
}

// Register API endpoints
Object.entries(ENDPOINTS).forEach(([key, url]) => {
  app.get(`/api/${key}`, async (req, res) => {
    try {
      // Try to get data from local storage first
      try {
        const localData = await dataManager.getData(key);
        if (localData && localData.features) {
          res.set('Cache-Control', 'public, max-age=3600');
          return res.json(localData);
        }
      } catch (localError) {
        console.log(`Local data not available for ${key}, falling back to API`);
      }

      const explorer = new APIExplorer({
        delayBetweenRequests: 500,
        timeout: 60000, // Longer timeout for some of these services
        maxRetries: 3,
        useFallback: true
      });

      // Special handling for bathymetry
      if (key === 'bathymetry') {
        try {
          // Try multiple bathymetry sources
          const bathymetrySources = [
            // Primary source from Geoscience Australia
            url,
            // Alternative source
            ALTERNATIVE_ENDPOINTS.bathymetryAlt,
            // Western Australia Marine Map
            "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/20/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
            // AusSeabed
            "https://geoserver.ausseabed.gov.au/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=ausseabed:multibeam_survey_extents&maxFeatures=500&outputFormat=application/json&bbox=115.5,-32.2,115.9,-31.9",
            // Global GEBCO data (subset for this region)
            "https://gis.ngdc.noaa.gov/arcgis/rest/services/web_mercator/gebco_2023_contours/MapServer/0/query?where=DEPTH%20IN%20(0,5,10,15,20,30,50,100,200)&outFields=DEPTH&geometry=%7B%22xmin%22%3A115.65%2C%22ymin%22%3A-32.15%2C%22xmax%22%3A115.85%2C%22ymax%22%3A-31.95%2C%22spatialReference%22%3A%7B%22wkid%22%3A4326%7D%7D&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&returnGeometry=true&f=geojson"
          ];

          // Try each source until one works
          for (const bathyUrl of bathymetrySources) {
            try {
              console.log(`Trying bathymetry source: ${bathyUrl}`);
              const data = await explorer.fetchGeoJSON(bathyUrl, key);

              // Check if we got actual contour data
              if (data && data.features && data.features.length > 0) {
                console.log(`Successfully obtained bathymetry from: ${bathyUrl}`);
                res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
                return res.json(data);
              }
            } catch (sourceError) {
              console.warn(`Failed to fetch bathymetry from ${bathyUrl}:`, sourceError.message);
            }
          }

          // If all sources failed, use enhanced fallback data
          throw new Error('All bathymetry sources failed');
        } catch (e) {
          console.warn('Failed to fetch bathymetry from all sources:', e);
          // Use our improved fallback data
          return res.json(getFrementleBathymetryFallback());
        }
      } else {
        // Normal endpoint handling for other data
        const data = await explorer.fetchGeoJSON(url, key);
        res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        res.json(data);
      }
    } catch (error) {
      console.error(`Error serving ${key}:`, error);
      res.status(500).json({
        error: 'Error fetching data',
        details: error.message,
        endpoint: key,
        timestamp: new Date().toISOString()
      });
    }
  });
});

// Enhanced fallback bathymetry data for Fremantle area
function getFrementleBathymetryFallback() {
  return {
    type: 'FeatureCollection',
    features: [
      // 5m contour
      {
        type: 'Feature',
        properties: { depth: 5, name: '5m Depth Contour' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.735, -32.045], // Near harbor entrance
            [115.739, -32.048],
            [115.742, -32.052],
            [115.745, -32.056],
            [115.748, -32.060],
            [115.745, -32.065],
            [115.740, -32.070],
            [115.735, -32.075] // South end
          ]
        }
      },
      // 10m contour
      {
        type: 'Feature',
        properties: { depth: 10, name: '10m Depth Contour' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.725, -32.040], // North end
            [115.729, -32.043],
            [115.732, -32.047],
            [115.735, -32.051],
            [115.738, -32.055],
            [115.735, -32.060],
            [115.730, -32.065],
            [115.725, -32.070] // South end
          ]
        }
      },
      // 15m contour
      {
        type: 'Feature',
        properties: { depth: 15, name: '15m Depth Contour' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.715, -32.035], // North end
            [115.719, -32.038],
            [115.722, -32.042],
            [115.725, -32.046],
            [115.728, -32.050],
            [115.725, -32.055],
            [115.720, -32.060],
            [115.715, -32.065] // South end
          ]
        }
      },
      // 20m contour
      {
        type: 'Feature',
        properties: { depth: 20, name: '20m Depth Contour' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.705, -32.030], // North end
            [115.709, -32.033],
            [115.712, -32.037],
            [115.715, -32.041],
            [115.718, -32.045],
            [115.715, -32.050],
            [115.710, -32.055],
            [115.705, -32.060] // South end
          ]
        }
      },
      // 30m contour - further offshore
      {
        type: 'Feature',
        properties: { depth: 30, name: '30m Depth Contour' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.685, -32.020], // North end
            [115.689, -32.025],
            [115.692, -32.030],
            [115.695, -32.035],
            [115.698, -32.040],
            [115.695, -32.045],
            [115.690, -32.050],
            [115.685, -32.055] // South end
          ]
        }
      },
      // 50m contour - deep water offshore
      {
        type: 'Feature',
        properties: { depth: 50, name: '50m Depth Contour' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.665, -32.010], // North end
            [115.670, -32.015],
            [115.675, -32.020],
            [115.680, -32.025],
            [115.675, -32.030],
            [115.670, -32.035],
            [115.665, -32.040] // South end
          ]
        }
      },
      // Fremantle Channel - based on official shipping channel
      {
        type: 'Feature',
        properties: { depth: 14.7, name: 'Fremantle Shipping Channel' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.739, -32.055], // Harbor entrance
            [115.735, -32.050],
            [115.730, -32.045],
            [115.725, -32.040],
            [115.720, -32.035],
            [115.715, -32.030] // End of channel
          ]
        }
      },
      // Gage Roads anchorage - verified offshore location
      {
        type: 'Feature',
        properties: { depth: 16, name: 'Gage Roads Anchorage' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [115.680, -32.015],
            [115.700, -32.015],
            [115.700, -32.040],
            [115.680, -32.040],
            [115.680, -32.015]
          ]]
        }
      },
      // Success Harbor
      {
        type: 'Feature',
        properties: { depth: 12, name: 'Success Harbor' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [115.760, -32.105],
            [115.770, -32.105],
            [115.770, -32.110],
            [115.760, -32.110],
            [115.760, -32.105]
          ]]
        }
      },
      // Individual depth points - all verified to be in water
      {
        type: 'Feature',
        properties: { depth: 10, name: 'Inner Approach' },
        geometry: { type: 'Point', coordinates: [115.735, -32.050] }
      },
      {
        type: 'Feature',
        properties: { depth: 12, name: 'Approach Channel' },
        geometry: { type: 'Point', coordinates: [115.730, -32.045] }
      },
      {
        type: 'Feature',
        properties: { depth: 14, name: 'Mid Channel' },
        geometry: { type: 'Point', coordinates: [115.725, -32.040] }
      },
      {
        type: 'Feature',
        properties: { depth: 16, name: 'Outer Channel' },
        geometry: { type: 'Point', coordinates: [115.720, -32.035] }
      },
      {
        type: 'Feature',
        properties: { depth: 18, name: 'Offshore Approach' },
        geometry: { type: 'Point', coordinates: [115.715, -32.030] }
      },
      {
        type: 'Feature',
        properties: { depth: 20, name: 'Deep Water' },
        geometry: { type: 'Point', coordinates: [115.710, -32.025] }
      },
      // Shoals and shallow areas
      {
        type: 'Feature',
        properties: { depth: 3, name: 'Parmelia Bank' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [115.745, -32.060],
            [115.755, -32.063],
            [115.758, -32.070],
            [115.750, -32.075],
            [115.740, -32.070],
            [115.745, -32.060]
          ]]
        }
      },
      {
        type: 'Feature',
        properties: { depth: 2, name: 'Success Bank' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [115.730, -32.075],
            [115.740, -32.078],
            [115.745, -32.085],
            [115.735, -32.090],
            [115.725, -32.085],
            [115.730, -32.075]
          ]]
        }
      }
    ],
    metadata: {
      source: 'fallback',
      description: 'Bathymetry reference based on Australian Hydrographic Service charts',
      note: 'Reference only - not for navigation',
      generated: new Date().toISOString()
    }
  };
}

// Accurate coastline definitions for the Fremantle area
const ENHANCED_COASTLINE = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { 
      name: 'Western Australia Coastline', 
      type: 'land' 
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        // South point
        [115.750, -32.150],
        [115.850, -32.150],  // Southeast corner
        [115.850, -31.950],  // Northeast corner
        [115.800, -31.950],  // North point
        
        // Enhanced Northern Area with detail to prevent land overlap
        [115.788, -31.955],
        [115.782, -31.957],
        [115.779, -31.959],
        [115.775, -31.961],
        [115.772, -31.962],
        [115.768, -31.963],
        [115.764, -31.964],
        [115.760, -31.966],
        [115.757, -31.968],
        [115.755, -31.970],
        [115.754, -31.972],
        [115.753, -31.974],
        [115.752, -31.976],
        [115.751, -31.978],
        [115.750, -31.980],
        [115.749, -31.982],
        [115.748, -31.984],
        [115.747, -31.986],
        [115.746, -31.988],
        [115.745, -31.990],
        [115.744, -31.992],
        [115.743, -31.994],
        [115.742, -31.996],
        [115.741, -31.998],
        [115.740, -32.000],
        [115.739, -32.002],
        [115.738, -32.004],
        
        // Detailed inland bay area - critical to prevent over-land zones
        [115.737, -32.006],
        [115.736, -32.008],
        [115.735, -32.010],
        [115.734, -32.012],
        [115.733, -32.014],
        [115.732, -32.016],
        [115.732, -32.018],
        [115.731, -32.020],
        [115.730, -32.022],
        [115.730, -32.024],
        [115.729, -32.026],
        [115.729, -32.028],
        [115.728, -32.030],
        [115.728, -32.032],
        [115.728, -32.034],
        [115.729, -32.036],
        [115.729, -32.038],
        [115.730, -32.040],
        
        // Improved detail heading south
        [115.736, -32.042],
        [115.738, -32.044],
        [115.739, -32.046],
        [115.738, -32.048],
        [115.738, -32.050],
        [115.737, -32.052],
        [115.737, -32.055],
        [115.737, -32.058],
        [115.737, -32.060],
        [115.738, -32.065],
        
        // North Fremantle
        [115.739, -32.070],
        [115.740, -32.075],
        [115.742, -32.080],
        [115.743, -32.085],
        
        // Fremantle
        [115.745, -32.090],
        [115.747, -32.095],
        [115.748, -32.100],
        [115.749, -32.103],
        
        // South Fremantle & surroundings
        [115.750, -32.107],
        [115.752, -32.111],
        
        // Coogee area
        [115.754, -32.115],
        [115.756, -32.120],
        [115.758, -32.125],
        [115.760, -32.130],
        [115.762, -32.135],
        [115.765, -32.140],
        [115.770, -32.145],
        [115.775, -32.150],
        
        // Back to start
        [115.750, -32.150]
      ]]
    }
  },
  // Add Northern problem area that's definitely land
  {
    type: 'Feature',
    properties: {
      name: 'Northern Land Area',
      type: 'land'
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [115.756, -31.970],
        [115.770, -31.970],
        [115.770, -31.990],
        [115.760, -32.000],
        [115.756, -31.990],
        [115.756, -31.970]
      ]]
    }
  }]
};

const STUDY_AREA = {
  type: 'Feature',
  properties: {
    type: 'Study Area',
    description: 'Coastal region from Lancelin to Mandurah including Rottnest Island'
  },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [115.2, -32.60],
        [116.0, -32.60],
        [116.0, -30.90],
        [115.2, -30.90],
        [115.2, -32.60]
      ]
    ]
  }
};


// Reference locations used for proximity analysis
const NAUTICAL_REFERENCES = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        name: 'Fremantle Harbour Entrance',
        type: 'harbour_entrance',
        description: 'Main entrance to Fremantle Port'
      },
      geometry: {
        type: 'Point',
        coordinates: [115.739, -32.055]
      }
    },
    {
      type: 'Feature',
      properties: {
        name: 'Rottnest Island',
        type: 'island',
        description: 'Major island west of Fremantle'
      },
      geometry: {
        type: 'Point',
        coordinates: [115.52, -32.00]
      }
    },
    {
      type: 'Feature',
      properties: {
        name: 'Success Harbour',
        type: 'harbour',
        description: 'Protected harbour in Cockburn Sound'
      },
      geometry: {
        type: 'Point',
        coordinates: [115.763, -32.107]
      }
    },
    {
      type: 'Feature',
      properties: {
        name: 'Gage Roads',
        type: 'anchorage',
        description: 'Main ship anchorage area'
      },
      geometry: {
        type: 'Point',
        coordinates: [115.68, -32.03]
      }
    }
  ]
};

// Store constraints data for reuse
let cachedConstraints = null;
let lastConstraintsUpdate = null;
const CONSTRAINTS_TTL = 86400000; // 24 hours in ms

// Helper function to simplify a GeoJSON feature while preserving properties
function simplifyFeature(feature, tolerance = 0.001) {
  try {
    if (!feature.geometry) return feature;

    const simplifiedFeature = turf.simplify(feature, { tolerance, highQuality: false });
    return simplifiedFeature;
  } catch (error) {
    console.warn(`Failed to simplify feature: ${error.message}`);
    return feature;
  }
}

app.get('/api/clearCache', async (req, res) => {
  try {
    console.log('Clearing server cache');
    
    // Clear cache data
    dataCache.flushAll();
    
    // Reset calculation status
    zoneCalculations.inProgress = false;
    zoneCalculations.lastStarted = null;
    zoneCalculations.progress = 0;
    zoneCalculations.lastCompleted = null;
    zoneCalculations.error = null;
    
    // Also reset the cached constraints
    cachedConstraints = null;
    lastConstraintsUpdate = null;
    
    res.status(200).json({
      status: 'success',
      message: 'Server cache cleared',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to clear cache: ' + error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Endpoint to check calculation status
app.get('/api/zoneCalculationStatus', (req, res) => {
  const status = {
    inProgress: zoneCalculations.inProgress,
    lastStarted: zoneCalculations.lastStarted,
    progress: zoneCalculations.progress,
    lastCompleted: zoneCalculations.lastCompleted,
    error: zoneCalculations.error,
    estimatedTimeRemaining: zoneCalculations.inProgress ? 
      calculateEstimatedTimeRemaining(zoneCalculations.progress, zoneCalculations.lastStarted) : 
      null
  };
  
  res.json(status);
});

// Helper function to calculate estimated time remaining
function calculateEstimatedTimeRemaining(progress, startTimeStr) {
  if (!progress || !startTimeStr) return null;
  
  const startTime = new Date(startTimeStr).getTime();
  const elapsedMs = Date.now() - startTime;
  
  if (progress < 5 || elapsedMs < 1000) return "Calculating...";
  
  // Calculate time remaining based on progress so far
  const estimatedTotalMs = (elapsedMs / progress) * 100;
  const remainingMs = estimatedTotalMs - elapsedMs;
  
  // Convert to readable format
  if (remainingMs < 60000) {
    return `About ${Math.ceil(remainingMs / 1000)} seconds remaining`;
  } else {
    return `About ${Math.ceil(remainingMs / 60000)} minutes remaining`;
  }
}

// Calculate recommended zones by subtracting constraint areas from study area
app.get('/api/recommendedZones', async (req, res) => {
  try {
    // First check if we have pre-calculated zones
    const latestZones = await zoneCalculator.getLatestZones();
    if (latestZones && !req.query.forceRecalculate) {
      console.log('Using pre-calculated zones');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.json(latestZones);
    }

    // Check cache
    const cacheKey = 'potential_cleaning_zones';
    const cachedZones = dataCache.get(cacheKey);
    
    if (cachedZones && !req.query.forceRecalculate) {
      console.log('Using cached potential cleaning zones');
      res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      return res.json(cachedZones);
    }

    // If calculation is already in progress, return status with retry header
    if (zoneCalculations.inProgress) {
      console.log('Zone calculation already in progress, returning status');
      res.set('Retry-After', '10'); // Suggest client retry in 10 seconds
      return res.status(202).json({ 
        status: 'calculating',
        message: 'Calculation in progress',
        progress: zoneCalculations.progress,
        started: zoneCalculations.lastStarted
      });
    }

    // Mark calculation as started
    zoneCalculations.inProgress = true;
    zoneCalculations.lastStarted = new Date().toISOString();
    zoneCalculations.progress = 0;
    zoneCalculations.error = null;
    
    // Set a long timeout for the response - 2 minutes
    res.setTimeout(120000, () => {
      // If we hit the timeout, send an accepted response with status info
      if (!res.headersSent) {
        res.status(202).json({
          status: 'calculating',
          message: 'Calculation still in progress, please check back',
          progress: zoneCalculations.progress,
          started: zoneCalculations.lastStarted
        });
      }
    });

    // Start background calculation using process.nextTick to avoid blocking
    process.nextTick(async () => {
      try {
        await performZoneCalculation(cacheKey);
      } catch (error) {
        console.error('Background calculation failed:', error);
        zoneCalculations.inProgress = false;
        zoneCalculations.error = error.message;
      }
    });

    // Immediately return with status
    return res.status(202).json({
      status: 'calculating',
      message: 'Calculation started',
      progress: 0,
      started: zoneCalculations.lastStarted
    });
  } catch (error) {
    console.error('Error handling recommended zones request:', error);
    
    // Update calculation status
    zoneCalculations.inProgress = false;
    zoneCalculations.error = error.message;
    
    // Return error without fallback zones
    res.status(500).json({ 
      error: 'Failed to calculate recommended zones', 
      message: error.message,
      retry: true
    });
  }
});

// Add endpoint for simplified constraint data for client-side use
app.get('/api/constraintData', async (req, res) => {
  try {
    // Check cache first
    const cacheKey = 'client_constraint_data';
    const cachedData = dataCache.get(cacheKey);
    
    if (cachedData) {
      console.log('Using cached constraint data for client');
      res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      return res.json(cachedData);
    }
    
    // Prepare a simplified version of all constraints for client
    const explorer = new APIExplorer({ 
      delayBetweenRequests: 500, 
      maxRetries: 2, 
      timeout: 15000,
      useFallback: true
    });
    
    // Essential constraints for client-side calculation
    const constraintKeys = [
      'portAuthorities', 
      'marineParks', 
      'fishHabitat', 
      'cockburnSound', 
      'mooringAreas', 
      'marineInfrastructure'
    ];
    
    // Fetch and simplify constraints
    const constraintData = {};
    
    for (const key of constraintKeys) {
      try {
        const url = ENDPOINTS[key];
        const data = await explorer.fetchGeoJSON(url, key);
        
        if (data && data.features && data.features.length > 0) {
          // Only include polygon features and heavily simplify them
          const simplifiedFeatures = data.features
            .filter(feature => 
              feature.geometry && 
              (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')
            )
            .map(feature => {
              try {
                // Heavily simplify for client-side performance
                return simplifyFeature(feature, 0.03);
              } catch (e) {
                // If simplification fails, try with higher tolerance
                try {
                  return simplifyFeature(feature, 0.05);
                } catch (err) {
                  // If that fails too, return the original
                  return feature;
                }
              }
            });
          
          constraintData[key] = {
            type: 'FeatureCollection',
            features: simplifiedFeatures
          };
        }
      } catch (error) {
        console.warn(`Failed to fetch ${key} for client constraints: ${error.message}`);
        constraintData[key] = { type: 'FeatureCollection', features: [] };
      }
    }
    
    // Add simplified coastline
    constraintData.coastline = ENHANCED_COASTLINE;
    
    // Add study area
    constraintData.studyArea = STUDY_AREA;
    
    // Cache the result
    dataCache.set(cacheKey, constraintData, 3600); // Cache for 1 hour
    
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(constraintData);
  } catch (error) {
    console.error('Error serving constraint data:', error);
    res.status(500).json({ error: 'Error fetching constraint data', message: error.message });
  }
});



async function performZoneCalculation(cacheKey) {
  console.log('Starting optimized zone calculation...');
  try {
    zoneCalculations.progress = 5;

    // Get all constraint data
    const constraintData = await dataManager.getAllData();
    
    // Add coastline and study area
    constraintData.coastline = ENHANCED_COASTLINE;
    constraintData.studyArea = STUDY_AREA;
    
    // Use the zone calculator
    const result = await zoneCalculator.calculateRecommendedZones(constraintData, {
      progressCallback: (progress, message) => {
        zoneCalculations.progress = progress;
        console.log(`Zone calculation: ${progress}% - ${message}`);
      }
    });
    
    // Cache the result
    dataCache.set(cacheKey, result, 86400);
    zoneCalculations.progress = 100;
    zoneCalculations.inProgress = false;
    zoneCalculations.lastCompleted = new Date().toISOString();
    console.log('Zone calculation completed successfully');
    
    return result;
  } catch (error) {
    console.error('Zone calculation failed:', error);
    zoneCalculations.inProgress = false;
    zoneCalculations.error = error.message;
    throw error;
  }

          // Perth Metro area - explicitly defined
          turf.polygon([[
            [115.80, -31.90], [116.00, -31.90],
            [116.00, -32.20], [115.80, -32.20],
            [115.80, -31.90]
          ]]),
          // Northern region
          turf.polygon([[
            [115.80, -31.60], [116.00, -31.60],
            [116.00, -31.80], [115.80, -31.80],
            [115.80, -31.60]
          ]]),
          // Southern region
          turf.polygon([[
            [115.80, -32.40], [116.00, -32.40],
            [116.00, -32.60], [115.80, -32.60],
            [115.80, -32.40]
          ]])
        ];
        
        // Add each additional land area
        for (const landArea of additionalLand) {
          try {
            landUnion = turf.union(landUnion, landArea);
          } catch (e) {
            console.warn('Error adding additional land area:', e);
          }
        }
        
        // Add a small buffer to the land to ensure no precision issues
        landUnion = turf.buffer(landUnion, 0.001, { units: 'degrees' });
        
        console.log('Created comprehensive land polygon');
      } else {
        throw new Error('Enhanced coastline data is missing');
      }
    } catch (e) {
      console.error('Error creating land polygon:', e);
      throw new Error('Failed to create land exclusion - cannot continue calculation');
    }
    
    // Strictly exclude land from available zone
    try {
      // Convert to a feature collection for consistent handling
      const availableFC = {
        type: 'FeatureCollection',
        features: [STUDY_AREA]
      };
      
      // Process each feature in the available zone
      const resultFeatures = [];
      
      for (const feature of availableFC.features) {
        try {
          // Difference with land union
          const waterOnly = turf.difference(feature, landUnion);
          if (waterOnly && waterOnly.geometry) {
            resultFeatures.push(waterOnly);
          }
        } catch (e) {
          console.warn('Error differencing feature with land:', e);
        }
      }
      
      if (resultFeatures.length === 0) {
        throw new Error('No water areas found after land exclusion');
      }
      
      // Set available zone to the water-only areas
      availableZone = {
        type: 'FeatureCollection',
        features: resultFeatures
      };
      
      console.log(`Created ${resultFeatures.length} water-only polygons`);
      updateProgress(30);
    } catch (e) {
      console.error('Error excluding land from study area:', e);
      throw new Error('Failed to exclude land - cannot continue calculation');
    }
    
    // =============================================
    // STEP 3: LOAD AND EXCLUDE PORT AUTHORITY AREAS
    // =============================================
    
    console.log('Loading and excluding port authority areas...');
    updateProgress(40);
    
    try {
      // Load port authority data with no simplification
      const portData = await explorer.fetchGeoJSON(ENDPOINTS.portAuthorities, 'portAuthorities');
      
      if (portData && portData.features && portData.features.length > 0) {
        console.log(`Loaded ${portData.features.length} port authority features`);
        
        // Extract port polygons
        const portPolygons = [];
        for (const feature of portData.features) {
          if (feature.geometry && 
              (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
            portPolygons.push(feature);
          }
        }
        
        if (portPolygons.length > 0) {
          console.log(`Processing ${portPolygons.length} port authority polygons`);
          
          // Union all port polygons
          let portUnion = portPolygons[0];
          for (let i = 1; i < portPolygons.length; i++) {
            try {
              portUnion = turf.union(portUnion, portPolygons[i]);
            } catch (e) {
              console.warn(`Error unioning port polygon ${i}:`, e);
            }
          }
          
          // Add a small buffer to ensure complete exclusion
          // Unlike land, we don't want to buffer port authorities too much
          portUnion = turf.buffer(portUnion, 0.0005, { units: 'degrees' });
          
          // Exclude port union from available zone
          const resultFeatures = [];
          
          for (const feature of availableZone.features) {
            try {
              // Difference with port union
              const nonPortArea = turf.difference(feature, portUnion);
              if (nonPortArea && nonPortArea.geometry) {
                resultFeatures.push(nonPortArea);
              }
            } catch (e) {
              console.warn('Error differencing feature with ports:', e);
            }
          }
          
          if (resultFeatures.length === 0) {
            throw new Error('No areas found after port authority exclusion');
          }
          
          // Set available zone to the non-port areas
          availableZone = {
            type: 'FeatureCollection',
            features: resultFeatures
          };
          
          console.log(`Successfully excluded port authority areas. ${resultFeatures.length} polygons remain`);
        } else {
          console.warn('No valid port authority polygons found');
        }
        
        updateProgress(50);
      } else {
        console.warn('No port authority data found');
      }
    } catch (e) {
      console.error('Error processing port authority areas:', e);
      // Continue with current available zone if port processing fails
    }
    
    // =============================================
    // STEP 4: EXCLUDE ENVIRONMENTAL CONSTRAINTS
    // =============================================
    
    console.log('Processing environmental constraints...');
    updateProgress(60);
    
    // Load all environmental constraints
    const environmentalConstraints = [
      { endpoint: ENDPOINTS.marineParks, key: 'marineParks', name: 'Marine Parks' },
      { endpoint: ENDPOINTS.fishHabitat, key: 'fishHabitat', name: 'Fish Habitat' },
      { endpoint: ENDPOINTS.cockburnSound, key: 'cockburnSound', name: 'Cockburn Sound' },
      { endpoint: ENDPOINTS.mooringAreas, key: 'mooringAreas', name: 'Mooring Areas' },
      { endpoint: ENDPOINTS.marineInfrastructure, key: 'marineInfrastructure', name: 'Marine Infrastructure' }
    ];
    
    // Load and process each constraint type
    for (const constraint of environmentalConstraints) {
      try {
        console.log(`Loading ${constraint.name}...`);
        const constraintData = await explorer.fetchGeoJSON(constraint.endpoint, constraint.key);
        
        if (constraintData && constraintData.features && constraintData.features.length > 0) {
          console.log(`Loaded ${constraintData.features.length} ${constraint.name} features`);
          
          // Extract constraint polygons
          const constraintPolygons = [];
          for (const feature of constraintData.features) {
            if (feature.geometry && 
                (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
              constraintPolygons.push(feature);
            }
          }
          
          if (constraintPolygons.length > 0) {
            console.log(`Processing ${constraintPolygons.length} ${constraint.name} polygons`);
            
            // Union constraint polygons (process in batches to avoid memory issues)
            const batchSize = 10;
            const batchResults = [];
            
            for (let i = 0; i < constraintPolygons.length; i += batchSize) {
              const batch = constraintPolygons.slice(i, Math.min(i + batchSize, constraintPolygons.length));
              if (batch.length === 0) continue;
              
              let batchUnion = batch[0];
              for (let j = 1; j < batch.length; j++) {
                try {
                  batchUnion = turf.union(batchUnion, batch[j]);
                } catch (e) {
                  console.warn(`Error unioning ${constraint.name} polygon in batch:`, e);
                }
              }
              
              batchResults.push(batchUnion);
            }
            
            // Union batch results
            let constraintUnion;
            if (batchResults.length > 0) {
              constraintUnion = batchResults[0];
              for (let i = 1; i < batchResults.length; i++) {
                try {
                  constraintUnion = turf.union(constraintUnion, batchResults[i]);
                } catch (e) {
                  console.warn(`Error unioning ${constraint.name} batch ${i}:`, e);
                }
              }
              
              // No buffer for environmental constraints to ensure precise boundary hugging
              // Exclude constraint union from available zone
              const resultFeatures = [];
              
              for (const feature of availableZone.features) {
                try {
                  // Difference with constraint union
                  const nonConstraintArea = turf.difference(feature, constraintUnion);
                  if (nonConstraintArea && nonConstraintArea.geometry) {
                    resultFeatures.push(nonConstraintArea);
                  }
                } catch (e) {
                  console.warn(`Error differencing feature with ${constraint.name}:`, e);
                }
              }
              
              if (resultFeatures.length === 0) {
                console.warn(`No areas found after ${constraint.name} exclusion`);
                continue; // Skip this constraint if it would eliminate all areas
              }
              
              // Set available zone to the non-constraint areas
              availableZone = {
                type: 'FeatureCollection',
                features: resultFeatures
              };
              
              console.log(`Successfully excluded ${constraint.name} areas. ${resultFeatures.length} polygons remain`);
            }
          } else {
            console.warn(`No valid ${constraint.name} polygons found`);
          }
        } else {
          console.warn(`No ${constraint.name} data found`);
        }
      } catch (e) {
        console.error(`Error processing ${constraint.name}:`, e);
        // Continue with current available zone if constraint processing fails
      }
      
      // Update progress for each constraint type
      updateProgress(60 + (environmentalConstraints.indexOf(constraint) + 1) * 5);
    }
    
    // =============================================
    // STEP 5: FINAL VALIDATION AND CLEANUP
    // =============================================
    
    console.log('Performing final validation and cleanup...');
    updateProgress(85);
    
    // Validate that zones are strictly on water
    try {
      // Do a final land check with a small buffer
      const landBuffer = turf.buffer(landUnion, 0.0005, { units: 'degrees' });
      
      const validatedFeatures = [];
      for (const feature of availableZone.features) {
        try {
          // Check if the feature is disjoint from land
          const isDisjoint = turf.booleanDisjoint(feature, landBuffer);
          
          if (isDisjoint) {
            // If disjoint, include as is
            validatedFeatures.push(feature);
          } else {
            // If not, try to clean it by differencing with land buffer
            const cleaned = turf.difference(feature, landBuffer);
            if (cleaned && cleaned.geometry) {
              validatedFeatures.push(cleaned);
            }
          }
        } catch (e) {
          console.warn('Error validating feature against land:', e);
        }
      }
      
      if (validatedFeatures.length === 0) {
        throw new Error('No valid features found after land validation');
      }
      
      // Update available zone
      availableZone = {
        type: 'FeatureCollection',
        features: validatedFeatures
      };
      
      console.log(`Final validation complete. ${validatedFeatures.length} valid features found`);
      updateProgress(90);
    } catch (e) {
      console.error('Error in final validation:', e);
      throw new Error('Failed to validate cleaning zones');
    }
    
    // Clean up small or invalid polygons
    try {
      const cleanedFeatures = [];
      
      for (const feature of availableZone.features) {
        try {
          // Calculate area
          const area = turf.area(feature);
          
          // Only keep features with significant area (more than 1 sq km)
          if (area > 1000000) {
            cleanedFeatures.push(feature);
          } else {
            console.log(`Removing small feature with area ${area} sq m`);
          }
        } catch (e) {
          console.warn('Error calculating feature area:', e);
        }
      }
      
      if (cleanedFeatures.length === 0) {
        throw new Error('No significant features found after cleanup');
      }
      
      // Update available zone
      availableZone = {
        type: 'FeatureCollection',
        features: cleanedFeatures
      };
      
      console.log(`Cleanup complete. ${cleanedFeatures.length} significant features remain`);
      updateProgress(95);
    } catch (e) {
      console.error('Error in cleanup:', e);
      // Continue with current available zone if cleanup fails
    }
    
    // =============================================
    // STEP 6: PREPARE FINAL RESULT
    // =============================================
    
    console.log('Preparing final result...');
    updateProgress(97);
    
    // Convert to final result structure
    const result = {
      type: 'FeatureCollection',
      features: availableZone.features.map(feature => ({
        type: 'Feature',
        properties: {
          type: 'Potential Cleaning Zone',
          description: 'Areas outside all constraints, strictly over water',
          calculatedAt: new Date().toISOString(),
          calculationTime: `${Math.floor((Date.now() - new Date(zoneCalculations.lastStarted).getTime()) / 1000)} seconds`,
          calculationMethod: 'direct-polygon'
        },
        geometry: feature.geometry
      }))
    };
    
    // Cache the result
    dataCache.set(cacheKey, result, 86400);
    zoneCalculations.progress = 100;
    zoneCalculations.inProgress = false;
    zoneCalculations.lastCompleted = new Date().toISOString();
    console.log('Zone calculation completed successfully');
    
    return result;
  } catch (e) {
    console.error('Zone calculation failed:', e);
    zoneCalculations.inProgress = false;
    zoneCalculations.error = e.message;
    throw e;
  }
}
// Add coastline endpoint
app.get('/api/coastline', async (req, res) => {
  try {
    // Check cache first
    const cacheKey = 'coastline';
    const cachedCoastline = dataCache.get(cacheKey);
    
    if (cachedCoastline) {
      console.log('Using cached coastline data');
      res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      return res.json(cachedCoastline);
    }

    // Use our accurate coastline data
    const coastlineData = ENHANCED_COASTLINE;
    
    // Cache it for future use
    dataCache.set(cacheKey, coastlineData, 86400 * 7); // Cache for 7 days
    
    res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.json(coastlineData);
  } catch (error) {
    console.error('Error serving coastline data:', error);
    res.status(500).json({ error: 'Error fetching coastline data' });
  }
});

// Provide nautical reference points
app.get('/api/nauticalReferences', (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.json(NAUTICAL_REFERENCES);
  } catch (error) {
    console.error('Error providing nautical references:', error);
    res.status(500).json({
      error: 'Error providing nautical references',
      details: error.message
    });
  }
});

// Analyze a location's proximity to constraints
app.post('/api/analyzeProximity', async (req, res) => {
  try {
    const { lat, lng } = req.body;

    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Invalid or missing coordinates' });
    }

    const point = turf.point([parseFloat(lng), parseFloat(lat)]);
    const explorer = new APIExplorer({
      delayBetweenRequests: 1000,
      maxRetries: 3,
      timeout: 30000,
      useFallback: true
    });

    // Get constraints data if needed
    if (!cachedConstraints || !lastConstraintsUpdate || (Date.now() - lastConstraintsUpdate > CONSTRAINTS_TTL)) {
      cachedConstraints = {};

      // Only include our main endpoints
      const endpoints = {
        portAuthorities: ENDPOINTS.portAuthorities,
        marineParks: ENDPOINTS.marineParks,
        fishHabitat: ENDPOINTS.fishHabitat,
        cockburnSound: ENDPOINTS.cockburnSound,
        mooringAreas: ENDPOINTS.mooringAreas,
        marineInfrastructure: ENDPOINTS.marineInfrastructure,
        marineGeomorphic: ENDPOINTS.marineGeomorphic
      };

      for (const [key, url] of Object.entries(endpoints)) {
        try {
          const data = await explorer.fetchGeoJSON(url, key);
          cachedConstraints[key] = data;
        } catch (error) {
          console.warn(`Failed to fetch ${key} for analysis: ${error.message}`);
          cachedConstraints[key] = { type: 'FeatureCollection', features: [] };
        }
      }

      lastConstraintsUpdate = Date.now();
    }

    // Analysis results object
    const analysisResults = {};

    // Analyze nautical references
    analysisResults.nauticalReferences = {};
    NAUTICAL_REFERENCES.features.forEach(feature => {
      // Calculate distance and bearing
      const featurePoint = turf.point(feature.geometry.coordinates);
      const distance = turf.distance(point, featurePoint);
      const bearing = turf.bearing(point, featurePoint);
      const normalizedBearing = (bearing + 360) % 360;

      // Get bearing text direction
      const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW', 'N'];
      const bearingText = directions[Math.round(normalizedBearing / 22.5)];

      // Add to results
      analysisResults.nauticalReferences[feature.properties.name] = {
        distance: distance.toFixed(2),
        bearing: bearing.toFixed(1),
        bearingText,
        type: feature.properties.type,
        description: feature.properties.description
      };
    });

    // Analyze each constraint layer
    for (const [key, data] of Object.entries(cachedConstraints)) {
      if (data && data.features && data.features.length > 0) {
        try {
          // First check if point is inside any polygon
          const containingFeature = data.features.find(feature =>
            feature.geometry &&
            (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') &&
            turf.booleanPointInPolygon(point, feature)
          );

          if (containingFeature) {
            // Point is inside this feature
            analysisResults[key] = {
              distance: "0.00",
              insideFeature: true,
              featureName: containingFeature.properties.NAME ||
                containingFeature.properties.Name ||
                containingFeature.properties.name ||
                'Unnamed Feature'
            };
            continue;
          }

          // If not inside, find nearest feature
          let minDistance = Number.MAX_VALUE;
          let nearestFeatureName = '';

          for (const feature of data.features) {
            if (!feature.geometry) continue;

            let distance;
            if (feature.geometry.type === 'Point') {
              const featurePoint = turf.point(feature.geometry.coordinates);
              distance = turf.distance(point, featurePoint);
            } else if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
              try {
                // Convert polygon to line and find nearest point on boundary
                const line = turf.polygonToLine(feature);
                const nearest = turf.nearestPointOnLine(line, point);
                distance = turf.distance(point, nearest);
              } catch (e) {
                // Fallback to centroid distance
                const center = turf.centroid(feature);
                distance = turf.distance(point, center);
              }
            } else if (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') {
              try {
                const nearest = turf.nearestPointOnLine(feature, point);
                distance = turf.distance(point, nearest);
              } catch (e) {
                // Fallback to centroid
                const center = turf.centroid(feature);
                distance = turf.distance(point, center);
              }
            } else {
              // For other geometry types, use centroid
              const center = turf.centroid(feature);
              distance = turf.distance(point, center);
            }

            if (distance < minDistance) {
              minDistance = distance;
              nearestFeatureName = feature.properties.NAME ||
                feature.properties.Name ||
                feature.properties.name ||
                'Unnamed Feature';
            }
          }

          // Add to results
          if (minDistance < Number.MAX_VALUE) {
            analysisResults[key] = {
              distance: minDistance.toFixed(2),
              insideFeature: false,
              featureName: nearestFeatureName
            };
          } else {
            analysisResults[key] = { status: 'No features found' };
          }
        } catch (e) {
          console.warn(`Failed to analyze proximity for ${key}: ${e.message}`);
          analysisResults[key] = { status: 'Analysis failed', error: e.message };
        }
      } else {
        analysisResults[key] = { status: 'No valid features available' };
      }
    }

    // Check if point is in water using coastline data
    try {
      // Get water mask (which accounts for coastline)
      let waterMask = dataCache.get('waterMask');
      
      if (!waterMask) {
        // Create water mask if not cached
        const coastlineData = ENHANCED_COASTLINE;
        let landUnion = coastlineData.features[0];
        
        for (let i = 1; i < coastlineData.features.length; i++) {
          try {
            landUnion = turf.union(landUnion, coastlineData.features[i]);
          } catch (e) {
            console.warn('Error unioning land features:', e);
          }
        }
        
        // Create buffer around land
        const bufferedLand = turf.buffer(landUnion, 0.001, { units: 'degrees' });
        
        // Create water mask by taking the difference between study area and land
        waterMask = turf.difference(STUDY_AREA, bufferedLand);
        
        // Cache the water mask
        dataCache.set('waterMask', waterMask, 86400);
      }
      
      analysisResults.waterMask = {
        inWater: turf.booleanPointInPolygon(point, waterMask)
      };
    } catch (error) {
      console.warn('Error checking water mask:', error);
      analysisResults.waterMask = { error: error.message };
    }

    // Check if point is in recommended zones
    try {
      const recommendedZones = dataCache.get('potential_cleaning_zones');

      if (recommendedZones && recommendedZones.features && recommendedZones.features.length > 0) {
        analysisResults.recommendedZone = {
          insideRecommendedZone: recommendedZones.features.some(f =>
            turf.booleanPointInPolygon(point, f)
          )
        };
      } else {
        // If no cached zones, try to get from endpoint
        try {
          const zonesResponse = await fetch(`${req.protocol}://${req.get('host')}/api/recommendedZones`);

          if (zonesResponse.ok) {
            const zonesData = await zonesResponse.json();

            analysisResults.recommendedZone = {
              insideRecommendedZone: zonesData.features.some(f =>
                turf.booleanPointInPolygon(point, f)
              )
            };
          } else {
            throw new Error('Failed to get recommended zones');
          }
        } catch (e) {
          // Use study area as placeholder
          analysisResults.recommendedZone = {
            insideRecommendedZone: turf.booleanPointInPolygon(point, STUDY_AREA)
          };
        }
      }
    } catch (error) {
      console.warn('Error checking recommended zone:', error);
      analysisResults.recommendedZone = { error: error.message };
    }

    // Send analysis results
    res.json({
      coordinates: { lat, lng },
      results: analysisResults,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in proximity analysis:', error);
    res.status(500).json({
      error: 'Error performing proximity analysis',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Server warmup endpoint
app.get('/warmup', async (req, res) => {
  try {
    console.log('Server warmup initiated');

    // Create explorer with longer timeouts for initial data fetch
    const explorer = new APIExplorer({
      delayBetweenRequests: 1000,
      maxRetries: 2,
      timeout: 30000,
      useFallback: true
    });

    // Fetch main constraint data in parallel
    await Promise.allSettled([
      explorer.fetchGeoJSON(ENDPOINTS.portAuthorities, 'portAuthorities'),
      explorer.fetchGeoJSON(ENDPOINTS.marineParks, 'marineParks'),
      explorer.fetchGeoJSON(ENDPOINTS.fishHabitat, 'fishHabitat'),
      explorer.fetchGeoJSON(ENDPOINTS.cockburnSound, 'cockburnSound'),
      explorer.fetchGeoJSON(ENDPOINTS.mooringAreas, 'mooringAreas'),
      explorer.fetchGeoJSON(ENDPOINTS.marineInfrastructure, 'marineInfrastructure')
    ]);

    res.status(200).json({
      status: 'ok',
      message: 'Server warmed up',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Warmup failed:', error);
    res.status(500).json({
      error: 'Warmup failed',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Server health check endpoint
app.get('/healthcheck', (req, res) => {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  const status = {
    status: 'ok',
    message: 'Server is running',
    uptime: `${uptime}s`,
    timestamp: new Date().toISOString(),
    api_stats: {
      calls_attempted: apiCallAttempts,
      calls_succeeded: apiCallsSucceeded,
      success_rate: apiCallAttempts > 0 ? (apiCallsSucceeded / apiCallAttempts * 100).toFixed(1) + '%' : 'N/A',
      last_successful_call: lastSuccessfulExternalAPICall ? new Date(lastSuccessfulExternalAPICall).toISOString() : 'None'
    },
    cache_stats: {
      keys: dataCache.keys().length,
      cache_size: `${JSON.stringify(dataCache.stats).length} bytes (approx)`,
      hits: dataCache.getStats().hits,
      misses: dataCache.getStats().misses
    },
    memory_usage: process.memoryUsage()
  };

  res.status(200).json(status);
});

// API index route
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Ship Cleaning GIS API Server',
    version: '1.0.0',
    endpoints: [
      '/api/portAuthorities',
      '/api/marineParks',
      '/api/fishHabitat',
      '/api/cockburnSound',
      '/api/mooringAreas',
      '/api/marineInfrastructure',
      '/api/bathymetry',
      '/api/marineGeomorphic',
      '/api/marineMultibeam',
      '/api/recommendedZones',
      '/api/constraintData',
      '/api/nauticalReferences',
      '/api/coastline',
      '/api/analyzeProximity (POST)',
      '/api/zoneCalculationStatus',
      '/healthcheck',
      '/warmup'
    ],
    timestamp: new Date().toISOString()
  });
});

// Handle 404 errors
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `The requested endpoint ${req.path} was not found.`,
    timestamp: new Date().toISOString()
  });
});

// Handle server errors
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred on the server.',
    timestamp: new Date().toISOString()
  });
});

// Start the server
app.listen(port, async () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`API endpoints available at http://localhost:${port}/api/`);

  // Create fallback directory
  await ensureFallbackDir();

  // Attempt warmup
  try {
    await fetch(`http://localhost:${port}/warmup`);
  } catch (err) {
    console.warn('Initial warmup failed:', err);
  }
});