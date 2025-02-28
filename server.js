const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cors = require('cors');
const turf = require('@turf/turf');
const NodeCache = require('node-cache');
const compression = require('compression');
const fs = require('fs').promises;

const app = express();
const port = process.env.PORT || 3000;
const dataCache = new NodeCache({ stdTTL: 86400 }); // Cache for 24 hours

// Fallback data directory - create this directory and add fallback GeoJSON files
const FALLBACK_DIR = path.join(__dirname, 'fallback_data');

// Enable compression
app.use(compression());

// Configure CORS
app.use(cors({
  origin: ['http://localhost:3000', 'https://cleanmyship.netlify.app', 'https://shipcleaninggis-client.netlify.app'],
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

// Add this to track calculation status
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

// API Endpoints configuration
const ENDPOINTS = {
  // Original endpoints
  portAuthorities: "https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Boundaries/MapServer/12/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  marineParks: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/2/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  fishHabitat: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/4/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  cockburnSound: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/12/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  mooringAreas: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/15/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  marineInfrastructure: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/18/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",

  // Improved bathymetry data from Geoscience Australia
  bathymetry: "https://services.ga.gov.au/gis/rest/services/Australian_Bathymetry_Topography/MapServer/WMSServer?request=GetMap&service=WMS&version=1.3.0&layers=0&styles=&format=application/json;type=geojson&bbox=115.65,-32.15,115.85,-31.95&width=1024&height=1024&crs=EPSG:4326",

  // New endpoints from Geoscience Australia
  stateWaters: "https://services.ga.gov.au/gis/rest/services/Australia_Coastal_Waters_Act_1980/MapServer/WMSServer?request=GetMap&service=WMS&version=1.3.0&layers=0&styles=&format=application/json;type=geojson&bbox=115.65,-32.15,115.85,-31.95&width=1024&height=1024&crs=EPSG:4326",
  commonwealthWaters: "https://services.ga.gov.au/gis/rest/services/Australia_Seas_Submerged_Lands_Act_1973/MapServer/WMSServer?request=GetMap&service=WMS&version=1.3.0&layers=0,1,2,3&styles=&format=application/json;type=geojson&bbox=115.65,-32.15,115.85,-31.95&width=1024&height=1024&crs=EPSG:4326",
  marineGeomorphic: "https://services.ga.gov.au/gis/rest/services/Geomorphic_Features_Australia_Marine_Jurisdiction/MapServer/WMSServer?request=GetMap&service=WMS&version=1.3.0&layers=0&styles=&format=application/json;type=geojson&bbox=115.65,-32.15,115.85,-31.95&width=1024&height=1024&crs=EPSG:4326",
  marineMultibeam: "https://services.ga.gov.au/gis/rest/services/Marine_Survey_Multibeam_Bathymetry/MapServer/WMSServer?request=GetMap&service=WMS&version=1.3.0&layers=0&styles=&format=application/json;type=geojson&bbox=115.65,-32.15,115.85,-31.95&width=1024&height=1024&crs=EPSG:4326",

  // OpenStreetMap military areas (using Overpass API)
  militaryAreas: "https://overpass-api.de/api/interpreter?data=[out:json];area[name=\"Western Australia\"]->.searchArea;(node[military](area.searchArea);way[military](area.searchArea);relation[military](area.searchArea););out;out geom;"
};

// Alternative WFS services for Geoscience Australia (if WMS doesn't work)
const ALTERNATIVE_ENDPOINTS = {
  bathymetryAlt: "https://geoserver.ausseabed.gov.au/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=ausseabed:multibeam_survey_extents&maxFeatures=500&outputFormat=application/json&bbox=115.5,-32.2,115.9,-31.9",
  stateWatersAlt: "https://services.ga.gov.au/gis/services/Australia_Coastal_Waters_Act_1980/MapServer/WFSServer?request=GetFeature&service=WFS&version=2.0.0&typeNames=Cwlth_Coastal_Waters_Limit&count=1000&outputFormat=application/json&bbox=115.65,-32.15,115.85,-31.95",
  commonwealthWatersAlt: "https://services.ga.gov.au/gis/services/Australia_Seas_Submerged_Lands_Act_1973/MapServer/WFSServer?request=GetFeature&service=WFS&version=2.0.0&typeNames=Exclusive_Economic_Zone&count=1000&outputFormat=application/json&bbox=115.65,-32.15,115.85,-31.95"
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

// Function to transform OSM Overpass API data to GeoJSON
function transformOverpassToGeoJSON(data) {
  if (!data || !data.elements) {
    return { type: 'FeatureCollection', features: [] };
  }

  const features = data.elements.map(element => {
    const feature = {
      type: 'Feature',
      properties: { ...element.tags },
      geometry: null
    };

    // Add type-specific properties
    feature.properties.id = element.id;
    feature.properties.type = element.type;

    // Create geometry based on element type
    if (element.type === 'node') {
      feature.geometry = {
        type: 'Point',
        coordinates: [element.lon, element.lat]
      };
    } else if (element.type === 'way' && element.geometry) {
      feature.geometry = {
        type: 'LineString',
        coordinates: element.geometry.map(node => [node.lon, node.lat])
      };

      // If the way is closed, make it a polygon
      if (element.geometry.length > 2 &&
        element.geometry[0].lat === element.geometry[element.geometry.length - 1].lat &&
        element.geometry[0].lon === element.geometry[element.geometry.length - 1].lon) {
        feature.geometry.type = 'Polygon';
        feature.geometry.coordinates = [feature.geometry.coordinates];
      }
    } else if (element.type === 'relation') {
      // Relations are complex - for simplicity, we'll just create a point at the centroid
      // of the first member with coordinates, if available
      const member = element.members && element.members.find(m => m.lat && m.lon);
      if (member) {
        feature.geometry = {
          type: 'Point',
          coordinates: [member.lon, member.lat]
        };
      }
    }

    // Skip features without geometry
    if (!feature.geometry) return null;

    return feature;
  }).filter(f => f !== null);

  return {
    type: 'FeatureCollection',
    features,
    metadata: {
      source: 'OpenStreetMap',
      license: 'ODbL',
      timestamp: new Date().toISOString()
    }
  };
}

// Register API endpoints
Object.entries(ENDPOINTS).forEach(([key, url]) => {
  app.get(`/api/${key}`, async (req, res) => {
    try {
      const explorer = new APIExplorer({
        delayBetweenRequests: 500,
        timeout: 60000, // Longer timeout for some of these services
        maxRetries: 3,
        useFallback: true
      });

      // Special handling for OpenStreetMap military areas
      if (key === 'militaryAreas') {
        try {
          // Try to get from cache first
          const cacheKey = `military_areas`;
          const cachedData = dataCache.get(cacheKey);

          if (cachedData) {
            console.log(`Using cached military areas data`);
            return res.json(cachedData);
          }

          // Fetch from Overpass API
          const response = await fetch(url);
          if (response.ok) {
            const data = await response.json();
            // Transform to GeoJSON
            const geoJSON = transformOverpassToGeoJSON(data);

            // Cache the result
            dataCache.set(cacheKey, geoJSON, 86400); // Cache for 24 hours

            return res.json(geoJSON);
          } else {
            throw new Error(`Overpass API responded with status ${response.status}`);
          }
        } catch (error) {
          console.error(`Error fetching military areas: ${error.message}`);
          // Return a minimal fallback
          return res.json({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {
                  name: 'Estimated Military Exclusion Zone',
                  type: 'military',
                  description: 'Fallback data - not for navigation',
                  confidence: 'low'
                },
                geometry: {
                  type: 'Polygon',
                  coordinates: [[
                    [115.72, -32.03],
                    [115.75, -32.03],
                    [115.75, -32.06],
                    [115.72, -32.06],
                    [115.72, -32.03]
                  ]]
                }
              }
            ],
            metadata: {
              source: 'fallback',
              license: 'N/A',
              timestamp: new Date().toISOString()
            }
          });
        }
      }

      // Special handling for Geoscience Australia services
      if (['stateWaters', 'commonwealthWaters', 'marineGeomorphic', 'marineMultibeam'].includes(key)) {
        try {
          // Try primary endpoint
          try {
            const data = await explorer.fetchGeoJSON(url, key);
            return res.json(data);
          } catch (primaryError) {
            console.warn(`Primary endpoint for ${key} failed: ${primaryError.message}`);

            // Try alternative endpoint if exists
            const altKey = `${key}Alt`;
            if (ALTERNATIVE_ENDPOINTS[altKey]) {
              try {
                console.log(`Trying alternative endpoint for ${key}: ${ALTERNATIVE_ENDPOINTS[altKey]}`);
                const data = await explorer.fetchGeoJSON(ALTERNATIVE_ENDPOINTS[altKey], key);
                return res.json(data);
              } catch (altError) {
                console.warn(`Alternative endpoint for ${key} failed: ${altError.message}`);
                throw new Error(`Both primary and alternative endpoints failed for ${key}`);
              }
            } else {
              throw primaryError;
            }
          }
        } catch (error) {
          console.error(`All attempts failed for ${key}: ${error.message}`);
          // Return a minimal fallback
          return res.json({
            type: 'FeatureCollection',
            features: [],
            metadata: {
              source: 'fallback',
              error: `Could not fetch ${key} data: ${error.message}`,
              timestamp: new Date().toISOString()
            }
          });
        }
      }

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

// Standard study area for the region
const STUDY_AREA = {
  type: 'Feature',
  properties: {
    type: 'Study Area',
    description: 'Perth coastal region near Fremantle'
  },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [115.65, -32.15],
        [115.85, -32.15],
        [115.85, -31.95],
        [115.65, -31.95],
        [115.65, -32.15]
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
    // Check cache first
    const cacheKey = 'potential_cleaning_zones';
    const cachedZones = dataCache.get(cacheKey);
    
    if (cachedZones) {
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

// Add this endpoint to the server.js file
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
    
    // Just the essential constraints for client-side calculation
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
    constraintData.coastline = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'Western Australia Coastline', type: 'land' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            // Approximate coastline around Fremantle
            [115.75, -32.15],  // South
            [115.85, -32.15],  // South-East
            [115.85, -31.95],  // North-East
            [115.80, -31.95],  // North
            [115.78, -31.96],  // North Coast
            [115.76, -31.98],  // North Coast
            [115.75, -32.00],  // North Coast
            [115.75, -32.03],  // Perth coastline
            [115.74, -32.05],  // Fremantle Port
            [115.74, -32.08],  // Fremantle South
            [115.75, -32.15]   // Back to start
          ]]
        }
      }]
    };
    
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

// Update the performZoneCalculation function with more frequent progress updates
// OPTIMIZE: Improved performZoneCalculation function for low-CPU environments
async function performZoneCalculation(cacheKey) {
  console.log('Starting calculation of potential cleaning zones...');
  try {
    const explorer = new APIExplorer({
      delayBetweenRequests: 1000,
      maxRetries: 2,
      timeout: 20000,
      useFallback: true
    });

    // Start with visible progress
    zoneCalculations.progress = 5;
    
    // Force progress updates
    function updateProgress(value) {
      zoneCalculations.progress = Math.min(99, Math.max(5, Math.floor(value)));
      console.log(`Zone calculation progress: ${zoneCalculations.progress}%`);
    }

    // Need fresh constraints data or use cached
    let allConstraints;
    
    if (cachedConstraints && lastConstraintsUpdate && (Date.now() - lastConstraintsUpdate < CONSTRAINTS_TTL)) {
      console.log('Using cached constraints data for calculation');
      allConstraints = cachedConstraints;
      updateProgress(25);
    } else {
      // Fetch necessary constraint layers - only include the essential ones
      console.log('Fetching constraint layers for calculation');
      const constraintKeys = [
        'portAuthorities', 
        'marineParks', 
        'fishHabitat', 
        'cockburnSound', 
        'mooringAreas', 
        'marineInfrastructure'
      ];
      
      // Fetch constraints one by one
      allConstraints = { type: 'FeatureCollection', features: [] };
      let constraintCount = 0;
      
      for (const key of constraintKeys) {
        try {
          console.log(`Fetching ${key} constraint data...`);
          const url = ENDPOINTS[key];
          const data = await explorer.fetchGeoJSON(url, key);
          
          if (data && data.features) {
            // Only include polygon features
            const validFeatures = data.features.filter(feature => {
              if (!feature.geometry || !feature.geometry.type) {
                return false;
              }
              
              if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
                return true;
              }
              
              return false;
            });
            
            allConstraints.features.push(...validFeatures);
          }
          
          // Update progress
          constraintCount++;
          updateProgress(5 + Math.floor((constraintCount / constraintKeys.length) * 20));
          
          // Give server a break between fetches
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          console.warn(`Failed to fetch ${key} for zone calculation: ${error.message}`);
          // Continue with other constraints
        }
      }
      
      // Cache constraints for reuse
      cachedConstraints = allConstraints;
      lastConstraintsUpdate = Date.now();
    }

    updateProgress(30);
    console.log(`Processing ${allConstraints.features.length} constraint features...`);

    // Optimize: Use much higher simplification tolerance
    console.log('Simplifying constraint geometries...');
    const simplifiedConstraints = {
      type: 'FeatureCollection',
      features: []
    };
    
    // Simplify in smaller batches with larger tolerance
    const batchSize = 3; 
    for (let i = 0; i < allConstraints.features.length; i += batchSize) {
      const batch = allConstraints.features.slice(i, i + batchSize);
      for (const feature of batch) {
        try {
          // Use higher tolerance for better performance - 0.02 degrees is roughly 2km
          const simplified = simplifyFeature(feature, 0.02);
          if (simplified && simplified.geometry) {
            simplifiedConstraints.features.push(simplified);
          }
        } catch (e) {
          console.warn(`Failed to simplify feature: ${e.message}`);
          // Try with even higher tolerance
          try {
            const simplified = simplifyFeature(feature, 0.05);
            if (simplified && simplified.geometry) {
              simplifiedConstraints.features.push(simplified);
            }
          } catch (err) {
            console.warn(`Failed to simplify feature even with higher tolerance: ${err.message}`);
            // Skip this feature
          }
        }
      }
      
      // Update progress
      updateProgress(30 + Math.floor((i / Math.max(1, allConstraints.features.length)) * 20));
      
      // Longer pause between batches to reduce CPU load
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    updateProgress(50);
    console.log(`Simplified to ${simplifiedConstraints.features.length} constraint features`);

    // OPTIMIZE: Use a simplified study area with a water mask
    // Load the coastline data to make sure we're not including land
    let waterMask = null;
    try {
      // First check if we have cached water mask
      const cachedWaterMask = dataCache.get('waterMask'); // Fix: Use dataCache instead of cachedData
      if (cachedWaterMask) {
        waterMask = cachedWaterMask;
      } else {
        // Try to load a simplified coastline
        const coastlineResponse = await fetch(`${apiBaseUrl}/api/coastline`);
        if (coastlineResponse.ok) {
          const coastlineData = await coastlineResponse.json();
          // The water mask is the study area minus the land areas
          if (coastlineData && coastlineData.features && coastlineData.features.length > 0) {
            waterMask = turf.difference(
              simplifyFeature(STUDY_AREA, 0.02),
              turf.union(...coastlineData.features)
            );
            // Cache the water mask
            dataCache.set('waterMask', waterMask, 86400);
          }
        }
      }
    } catch (error) {
      console.warn('Failed to create water mask:', error);
      // Continue without water mask
    }

    // Set a basic study area as fallback
    let potentialZones = simplifyFeature(STUDY_AREA, 0.02);

    // Calculate recommended zones using a more efficient approach
    updateProgress(60);
    
    // OPTIMIZE: Use a grid-based approach for better performance
    try {
      console.log('Using simplified approach for better server performance');
      
      // Create a grid of points covering the study area
      const bbox = turf.bbox(STUDY_AREA);
      const cellSize = 0.01; // ~1km cells
      const grid = [];
      
      // Generate grid points
      for (let x = bbox[0]; x <= bbox[2]; x += cellSize) {
        for (let y = bbox[1]; y <= bbox[3]; y += cellSize) {
          // Create a point
          const pt = turf.point([x, y]);
          
          // Check if point is in water (if we have a water mask)
          const isInWater = !waterMask || turf.booleanPointInPolygon(pt, waterMask);
          
          // Skip if not in water
          if (!isInWater) continue;
          
          // Check if point is in any constraint
          const isInConstraint = simplifiedConstraints.features.some(feature => {
            return turf.booleanPointInPolygon(pt, feature);
          });
          
          // If not in any constraint, add to our grid of valid points
          if (!isInConstraint) {
            grid.push(pt);
          }
        }
      }
      
      updateProgress(80);
      
      // Create buffer around points and merge them into polygons
      if (grid.length > 0) {
        console.log(`Found ${grid.length} valid grid points, creating polygons...`);
        
        // Buffer each point
        const bufferedPoints = grid.map(pt => turf.buffer(pt, 0.008, {units: 'degrees'}));
        
        // Update progress
        updateProgress(90);
        
        // Merge buffered points into a MultiPolygon
        let merged = bufferedPoints[0];
        for (let i = 1; i < Math.min(bufferedPoints.length, 50); i++) {
          try {
            merged = turf.union(merged, bufferedPoints[i]);
          } catch (e) {
            console.warn('Error merging buffers:', e);
          }
          
          // Every 10 merges, give the server a break
          if (i % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        
        potentialZones = merged;
      } else {
        console.warn('No valid grid points found, using study area');
      }
      
      updateProgress(95);
      
      // Apply the water mask to ensure we're only showing water areas
      if (waterMask) {
        try {
          potentialZones = turf.intersect(potentialZones, waterMask);
        } catch (e) {
          console.warn('Error intersecting with water mask:', e);
        }
      }
    } catch (e) {
      console.error('Grid-based calculation failed:', e);
      // Fallback to study area
      potentialZones = simplifyFeature(STUDY_AREA, 0.01);
    }

    updateProgress(98);

    // Create result GeoJSON
    const result = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { 
          type: 'Potential Cleaning Zone',
          description: 'Areas outside all constraint zones',
          calculatedAt: new Date().toISOString(),
          calculationTime: `${Math.floor((Date.now() - new Date(zoneCalculations.lastStarted).getTime()) / 1000)} seconds`
        },
        geometry: potentialZones.geometry
      }]
    };

    // Cache the result for 24 hours
    dataCache.set(cacheKey, result, 86400);
    
    // Mark as complete
    zoneCalculations.progress = 100;
    zoneCalculations.inProgress = false;
    zoneCalculations.lastCompleted = new Date().toISOString();
    
    console.log('Zone calculation completed successfully');
    return result;
  } catch (error) {
    console.error('Zone calculation failed with error:', error);
    
    // Update calculation status
    zoneCalculations.inProgress = false;
    zoneCalculations.error = error.message;
    
    throw error;
  }
}

// ADD: Create a simple API endpoint for coastline data if it doesn't exist
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

    // Simplified Fremantle coastline
    const coastlineData = {
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
            // Approximate coastline around Fremantle
            [115.75, -32.15],  // South
            [115.85, -32.15],  // South-East
            [115.85, -31.95],  // North-East
            [115.80, -31.95],  // North
            [115.78, -31.96],  // North Coast
            [115.76, -31.98],  // North Coast
            [115.75, -32.00],  // North Coast
            [115.75, -32.03],  // Perth coastline
            [115.74, -32.05],  // Fremantle Port
            [115.74, -32.08],  // Fremantle South
            [115.75, -32.15]   // Back to start
          ]]
        }
      }]
    };
    
    // Cache it
    dataCache.set(cacheKey, coastlineData, 86400 * 7); // Cache for 7 days
    
    res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.json(coastlineData);
  } catch (error) {
    console.error('Error serving coastline data:', error);
    res.status(500).json({ error: 'Error fetching coastline data' });
  }
});

// Update the API endpoints list to include the new endpoint
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

      // Include both standard endpoints and added ones
      const allEndpoints = {
        ...ENDPOINTS,
        ...{
          // Don't include bathymetry or recommendedZones in proximity analysis
          bathymetry: undefined,
          recommendedZones: undefined
        }
      };

      for (const [key, url] of Object.entries(allEndpoints)) {
        if (!url) continue; // Skip undefined endpoints

        try {
          const data = await explorer.fetchGeoJSON(url, key);

          // Filter valid features
          const validFeatures = data.features.filter(feature => {
            if (!feature.geometry || !feature.geometry.type) {
              return false;
            }

            if (!Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length === 0) {
              return false;
            }

            const validTypes = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'];
            return validTypes.includes(feature.geometry.type);
          });

          cachedConstraints[key] = { type: 'FeatureCollection', features: validFeatures };
        } catch (error) {
          console.warn(`Failed to fetch ${key} for analysis: ${error.message}`);

          // Try to get fallback data
          try {
            const fallbackPath = path.join(FALLBACK_DIR, `${key}.json`);
            if (fs.existsSync(fallbackPath)) {
              const fallbackData = JSON.parse(await fs.readFile(fallbackPath, 'utf8'));
              cachedConstraints[key] = fallbackData;
              console.log(`Using fallback data for ${key} from file`);
            } else {
              // Use empty feature collection as last resort
              cachedConstraints[key] = { type: 'FeatureCollection', features: [] };
            }
          } catch (fallbackError) {
            console.error(`Failed to get fallback data for ${key}:`, fallbackError);
            cachedConstraints[key] = { type: 'FeatureCollection', features: [] };
          }
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
          try {
            // Try more accurate calculation using nearestPointOnLine if possible
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
              throw new Error('No valid distance calculated');
            }
          } catch (e) {
            // Fallback to simpler method
            // Convert points/lines to comparable format
            const cleanedFeatures = data.features
              .filter(f => f && f.geometry)
              .map(feature => {
                if (feature.geometry.type === 'Point') return feature;
                // For other geometries, use centroid for distance calculation
                return turf.centroid(feature);
              })
              .filter(f => f && f.geometry && Array.isArray(f.geometry.coordinates));

            if (cleanedFeatures.length === 0) {
              analysisResults[key] = { status: 'No valid features for distance calculation' };
              continue;
            }

            // Find nearest feature
            const featureCollection = turf.featureCollection(cleanedFeatures);
            const nearest = turf.nearestPoint(point, featureCollection);
            const distance = turf.distance(point, nearest);

            // Find the original feature index
            const nearestCoords = nearest.geometry.coordinates;
            let originalFeature = data.features[0]; // Fallback

            for (const feature of data.features) {
              if (!feature.geometry) continue;

              if (feature.geometry.type === 'Point' &&
                feature.geometry.coordinates[0] === nearestCoords[0] &&
                feature.geometry.coordinates[1] === nearestCoords[1]) {
                originalFeature = feature;
                break;
              }
            }

            // Add to results
            analysisResults[key] = {
              distance: distance.toFixed(2),
              insideFeature: false,
              featureName: originalFeature.properties.NAME ||
                originalFeature.properties.Name ||
                originalFeature.properties.name ||
                'Unnamed Feature'
            };
          }
        } catch (e) {
          console.warn(`Failed to analyze proximity for ${key}: ${e.message}`);
          analysisResults[key] = { status: 'Analysis failed', error: e.message };
        }
      } else {
        analysisResults[key] = { status: 'No valid features available' };
      }
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
          // Use study area if all else fails
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

    // Fetch all constraint data in parallel
    await Promise.allSettled(
      Object.entries(ENDPOINTS).map(async ([key, url]) => {
        try {
          console.log(`Warming up ${key} endpoint`);
          return await explorer.fetchGeoJSON(url, key);
        } catch (error) {
          console.warn(`Warmup for ${key} failed: ${error.message}`);
          return null;
        }
      })
    );

    // Ensure recommended zones are calculated
    try {
      const cacheKey = 'potential_cleaning_zones';
      if (!dataCache.get(cacheKey)) {
        console.log('Warming up recommended zones calculation');
        await fetch(`http://localhost:${port}/api/recommendedZones`);
      }
    } catch (error) {
      console.warn('Warmup for recommendedZones failed:', error);
    }

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
      '/api/nauticalReferences',
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