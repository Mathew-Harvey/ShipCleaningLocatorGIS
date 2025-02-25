const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cors = require('cors');
const turf = require('@turf/turf');
const NodeCache = require('node-cache');

const app = express();
const port = process.env.PORT || 3000;
const dataCache = new NodeCache({ stdTTL: 3600 });

app.use(cors({
  origin: ['http://localhost:3000', 'https://cleanmyship.netlify.app', 'https://shipcleaninggis-client.netlify.app'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.static('public'));
app.use(express.json());

class APIExplorer {
  constructor(options = {}) {
    this.delayBetweenRequests = options.delayBetweenRequests || 1000;
    this.maxRetries = options.maxRetries || 5;
    this.commonHeaders = options.headers || {
      'x-api-key': '8f45eac321494fcbb5c38e116c841163'
    };
    this.timeout = options.timeout || 60000;
  }

  async rateLimitedFetch(url, options = {}) {
    let retries = 0;
    const startTime = Date.now();
    while (retries < this.maxRetries) {
      try {
        await new Promise(resolve => setTimeout(resolve, this.delayBetweenRequests));
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        const response = await fetch(url, {
          headers: this.commonHeaders,
          ...options,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        console.log(`Fetched ${url} in ${Date.now() - startTime}ms`);
        return response;
      } catch (err) {
        retries++;
        console.warn(`Retry ${retries}/${this.maxRetries} for ${url} after ${Date.now() - startTime}ms: ${err.message}`);
        if (retries === this.maxRetries) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retries)));
      }
    }
  }

  async fetchGeoJSON(url) {
    try {
      const cacheKey = `geojson_${url}`;
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
      dataCache.set(cacheKey, cleanedData);
      console.log(`Caching valid GeoJSON from: ${url}`);
      return cleanedData;
    } catch (err) {
      console.error(`Endpoint ${url} failed: ${err.message}`);
      throw err;
    }
  }

  cleanupGeoJSON(data) {
    if (!data || !data.type) return data;

    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
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
  marineInfrastructure: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/18/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson"
};

Object.entries(ENDPOINTS).forEach(([key, url]) => {
  app.get(`/api/${key}`, async (req, res) => {
    try {
      const explorer = new APIExplorer({ delayBetweenRequests: 500, timeout: 60000, maxRetries: 5 });
      const data = await explorer.fetchGeoJSON(url);
      res.json(data);
    } catch (error) {
      console.error(`Error serving ${key}:`, error);
      res.status(500).json({ error: 'Error fetching data', details: error.message, endpoint: key });
    }
  });
});

const STUDY_AREA = {
  type: 'Feature',
  properties: {},
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

const NAUTICAL_REFERENCES = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Fremantle Harbour Entrance', type: 'harbour_entrance', description: 'Main entrance to Fremantle Port' }, geometry: { type: 'Point', coordinates: [115.739, -32.055] } },
    { type: 'Feature', properties: { name: 'Rottnest Island', type: 'island', description: 'Major island west of Fremantle' }, geometry: { type: 'Point', coordinates: [115.52, -32.00] } },
    { type: 'Feature', properties: { name: 'Success Harbour', type: 'harbour', description: 'Protected harbour in Cockburn Sound' }, geometry: { type: 'Point', coordinates: [115.763, -32.107] } },
    { type: 'Feature', properties: { name: 'Gage Roads', type: 'anchorage', description: 'Main ship anchorage area' }, geometry: { type: 'Point', coordinates: [115.68, -32.03] } }
  ]
};

let cachedConstraints = null;

app.get('/api/recommendedZones', async (req, res) => {
  try {
    const cacheKey = 'potential_cleaning_zones';
    const cachedZones = dataCache.get(cacheKey);
    if (cachedZones) {
      console.log('Using cached potential cleaning zones');
      return res.json(cachedZones);
    }

    console.log('Calculating potential cleaning zones...');
    const explorer = new APIExplorer({ delayBetweenRequests: 1000, maxRetries: 5, timeout: 60000 });

    const constraints = await Promise.all(
      Object.values(ENDPOINTS).map(url => explorer.fetchGeoJSON(url).catch(err => {
        console.warn(`Failed to fetch ${url}: ${err.message}`);
        return null;
      }))
    );

    let allConstraints = { type: 'FeatureCollection', features: [] };
    constraints.filter(c => c && c.features).forEach(c => {
      const validFeatures = c.features.filter(feature => {
        if (!feature.geometry || !feature.geometry.type) {
          console.warn(`Skipping feature with no geometry: ${JSON.stringify(feature)}`);
          return false;
        }
        if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
          return true;
        }
        console.warn(`Skipping non-polygon feature: ${feature.geometry.type}`);
        return false;
      });
      allConstraints.features.push(...validFeatures);
    });

    let constraintUnion = null;
    if (allConstraints.features.length > 0) {
      try {
        allConstraints.features = allConstraints.features.map(feature => 
          turf.simplify(feature, { tolerance: 0.001, highQuality: true })
        );
        const batchSize = 10;
        for (let i = 0; i < allConstraints.features.length; i += batchSize) {
          const batch = allConstraints.features.slice(i, i + batchSize);
          constraintUnion = batch.reduce((acc, curr) => {
            try {
              return acc ? turf.union(acc, curr) : curr;
            } catch (e) {
              console.warn(`Failed to union feature in batch: ${e.message}`);
              return acc;
            }
          }, constraintUnion);
        }
      } catch (e) {
        console.error('Union operation failed entirely:', e);
        constraintUnion = null;
      }
    }

    const potentialZones = constraintUnion ? turf.difference(STUDY_AREA, constraintUnion) : STUDY_AREA;
    const result = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { type: 'Potential Cleaning Zone' }, geometry: potentialZones.geometry }]
    };

    dataCache.set(cacheKey, result, 86400);
    res.json(result);
  } catch (error) {
    console.error('Error calculating recommended zones:', error);
    res.status(500).json({ error: 'Calculation failed', details: error.message });
  }
});

app.get('/api/nauticalReferences', (req, res) => {
  try {
    res.json(NAUTICAL_REFERENCES);
  } catch (error) {
    console.error('Error providing nautical references:', error);
    res.status(500).json({ error: 'Error providing nautical references', details: error.message });
  }
});

app.post('/api/analyzeProximity', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Invalid or missing coordinates' });
    }

    const point = turf.point([parseFloat(lng), parseFloat(lat)]);
    const explorer = new APIExplorer({ delayBetweenRequests: 1000, maxRetries: 5, timeout: 60000 });

    if (!cachedConstraints) {
      cachedConstraints = {};
      for (const [key, url] of Object.entries(ENDPOINTS)) {
        const data = await explorer.fetchGeoJSON(url);
        const validFeatures = data.features.filter(feature => {
          if (!feature.geometry || !feature.geometry.type) {
            console.warn(`Skipping feature with no geometry in ${key}: ${JSON.stringify(feature)}`);
            return false;
          }
          if (!Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length === 0) {
            console.warn(`Skipping feature with invalid coordinates in ${key}: ${JSON.stringify(feature)}`);
            return false;
          }
          const validTypes = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'];
          return validTypes.includes(feature.geometry.type);
        });
        cachedConstraints[key] = { type: 'FeatureCollection', features: validFeatures };
      }
    }

    const analysisResults = {};
    analysisResults.nauticalReferences = {};
    NAUTICAL_REFERENCES.features.forEach(feature => {
      const distance = turf.distance(point, feature);
      const bearing = turf.bearing(point, feature);
      const normalizedBearing = (bearing + 360) % 360;
      const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW', 'N'];
      const bearingText = directions[Math.round(normalizedBearing / 22.5)];

      analysisResults.nauticalReferences[feature.properties.name] = {
        distance: distance.toFixed(2),
        bearing: bearing.toFixed(1),
        bearingText,
        type: feature.properties.type,
        description: feature.properties.description
      };
    });

    for (const [key, data] of Object.entries(cachedConstraints)) {
      if (data && data.features && data.features.length > 0) {
        try {
          const cleanedFeatures = data.features.map(feature => {
            if (feature.geometry.type === 'Point') return feature;
            if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
              return turf.centroid(feature);
            }
            return turf.centroid(feature);
          }).filter(f => f && f.geometry && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length >= 2);

          if (cleanedFeatures.length === 0) {
            analysisResults[key] = { status: 'No valid features after cleaning' };
            continue;
          }

          const featureCollection = turf.featureCollection(cleanedFeatures);
          const nearest = turf.nearestPoint(point, featureCollection);
          const distance = turf.distance(point, nearest);

          const isInside = data.features.some(f => 
            (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') && 
            turf.booleanPointInPolygon(point, f)
          );

          analysisResults[key] = {
            distance: distance.toFixed(2),
            insideFeature: isInside,
            featureName: nearest.properties.NAME || nearest.properties.Name || nearest.properties.name || 'Unnamed'
          };
        } catch (e) {
          console.warn(`Failed to analyze proximity for ${key}: ${e.message}`);
          analysisResults[key] = { status: 'Analysis failed', error: e.message };
        }
      } else {
        analysisResults[key] = { status: 'No valid features available' };
      }
    }

    const recommendedZones = dataCache.get('potential_cleaning_zones') || 
      await (await fetch(`${req.protocol}://${req.get('host')}/api/recommendedZones`)).json();
    analysisResults.recommendedZone = {
      insideRecommendedZone: recommendedZones.features.some(f => turf.booleanPointInPolygon(point, f))
    };

    res.json({ coordinates: { lat, lng }, results: analysisResults });
  } catch (error) {
    console.error('Error in proximity analysis:', error);
    res.status(500).json({ error: 'Error performing proximity analysis', details: error.message });
  }
});

app.get('/warmup', async (req, res) => {
  try {
    const explorer = new APIExplorer({ delayBetweenRequests: 1000, maxRetries: 5, timeout: 60000 });
    await Promise.all(Object.values(ENDPOINTS).map(url => explorer.fetchGeoJSON(url)));
    await fetch(`http://localhost:${port}/api/recommendedZones`);
    res.status(200).json({ status: 'ok', message: 'Server warmed up' });
  } catch (error) {
    console.error('Warmup failed:', error);
    res.status(500).json({ error: 'Warmup failed', details: error.message });
  }
});

app.get('/healthcheck', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Ship Cleaning GIS API Server',
    endpoints: [
      '/api/portAuthorities',
      '/api/marineParks',
      '/api/fishHabitat',
      '/api/cockburnSound',
      '/api/mooringAreas',
      '/api/marineInfrastructure',
      '/api/recommendedZones',
      '/api/nauticalReferences',
      '/api/analyzeProximity (POST)',
      '/healthcheck',
      '/warmup'
    ]
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`API endpoints available at http://localhost:${port}/api/`);
  fetch(`http://localhost:${port}/warmup`).catch(err => console.warn('Initial warmup failed:', err));
});