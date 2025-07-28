const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs').promises;
const DataManager = require('./dataManager');
const ZoneCalculator = require('./zoneCalculator');

const app = express();
const port = process.env.PORT || 3000;

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

// Enable compression
app.use(compression());

// Configure CORS for all origins since it's self-hosted
app.use(cors());

// Static files
app.use(express.static('public', { maxAge: '1h' }));
app.use(express.json({ limit: '1mb' }));

// Server status vars
let serverStartTime = Date.now();

// Track zone calculation status
const zoneCalculationStatus = {
  inProgress: false,
  lastStarted: null,
  progress: 0,
  lastCompleted: null,
  error: null
};

// Coastal and study area definitions
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
        [115.750, -32.150],
        [115.850, -32.150],
        [115.850, -31.950],
        [115.800, -31.950],
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
        [115.739, -32.070],
        [115.740, -32.075],
        [115.742, -32.080],
        [115.743, -32.085],
        [115.745, -32.090],
        [115.747, -32.095],
        [115.748, -32.100],
        [115.749, -32.103],
        [115.750, -32.107],
        [115.752, -32.111],
        [115.754, -32.115],
        [115.756, -32.120],
        [115.758, -32.125],
        [115.760, -32.130],
        [115.762, -32.135],
        [115.765, -32.140],
        [115.770, -32.145],
        [115.775, -32.150],
        [115.750, -32.150]
      ]]
    }
  },
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
    coordinates: [[
      [115.2, -32.60],
      [116.0, -32.60],
      [116.0, -30.90],
      [115.2, -30.90],
      [115.2, -32.60]
    ]]
  }
};

// API endpoints mapping
const endpoints = [
  'portAuthorities',
  'marineParks',
  'fishHabitat',
  'cockburnSound',
  'mooringAreas',
  'marineInfrastructure',
  'ausMarineParks',
  'osmHarbours',
  'osmMarinas'
];

// Register data endpoints
endpoints.forEach(key => {
  app.get(`/api/${key}`, async (req, res) => {
    try {
      const data = await dataManager.getData(key);
      res.set('Cache-Control', 'public, max-age=3600');
      res.json(data);
    } catch (error) {
      console.error(`Error serving ${key}:`, error);
      res.status(500).json({
        error: 'Error fetching data',
        details: error.message,
        endpoint: key
      });
    }
  });
});

// Bathymetry endpoint with fallback
app.get('/api/bathymetry', async (req, res) => {
  try {
    const data = await dataManager.getData('gebcoBathymetry');
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(data);
  } catch (error) {
    console.warn('Failed to get bathymetry data:', error);
    // Return fallback bathymetry data
    res.json(getFrementleBathymetryFallback());
  }
});

// Recommended zones endpoint
app.get('/api/recommendedZones', async (req, res) => {
  try {
    // First check for pre-calculated zones
    const latestZones = await zoneCalculator.getLatestZones();
    if (latestZones && !req.query.forceRecalculate) {
      console.log('Using pre-calculated zones');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.json(latestZones);
    }

    // If calculation is in progress, return status
    if (zoneCalculationStatus.inProgress) {
      return res.status(202).json({
        status: 'calculating',
        message: 'Calculation in progress',
        progress: zoneCalculationStatus.progress,
        started: zoneCalculationStatus.lastStarted
      });
    }

    // Start new calculation
    zoneCalculationStatus.inProgress = true;
    zoneCalculationStatus.lastStarted = new Date().toISOString();
    zoneCalculationStatus.progress = 0;
    zoneCalculationStatus.error = null;

    // Perform calculation asynchronously
    performZoneCalculation();

    return res.status(202).json({
      status: 'calculating',
      message: 'Calculation started',
      progress: 0,
      started: zoneCalculationStatus.lastStarted
    });
  } catch (error) {
    console.error('Error handling recommended zones request:', error);
    res.status(500).json({ 
      error: 'Failed to calculate recommended zones', 
      message: error.message
    });
  }
});

// Zone calculation status endpoint
app.get('/api/zoneCalculationStatus', (req, res) => {
  res.json({
    inProgress: zoneCalculationStatus.inProgress,
    lastStarted: zoneCalculationStatus.lastStarted,
    progress: zoneCalculationStatus.progress,
    lastCompleted: zoneCalculationStatus.lastCompleted,
    error: zoneCalculationStatus.error
  });
});

// Coastline endpoint
app.get('/api/coastline', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json(ENHANCED_COASTLINE);
});

// Constraint data endpoint for client-side calculations
app.get('/api/constraintData', async (req, res) => {
  try {
    const constraintData = await dataManager.getAllData();
    constraintData.coastline = ENHANCED_COASTLINE;
    constraintData.studyArea = STUDY_AREA;
    
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(constraintData);
  } catch (error) {
    console.error('Error serving constraint data:', error);
    res.status(500).json({ 
      error: 'Error fetching constraint data', 
      message: error.message 
    });
  }
});

// Clear cache endpoint
app.get('/api/clearCache', async (req, res) => {
  try {
    console.log('Clearing server cache');
    
    // Reset zone calculation status
    zoneCalculationStatus.inProgress = false;
    zoneCalculationStatus.progress = 0;
    
    res.json({
      status: 'success',
      message: 'Cache cleared',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to clear cache: ' + error.message
    });
  }
});

// Data status endpoint
app.get('/api/dataStatus', async (req, res) => {
  try {
    const status = await dataManager.getDataStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting data status:', error);
    res.status(500).json({ error: 'Failed to get data status' });
  }
});

// Health check endpoint
app.get('/healthcheck', (req, res) => {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  res.json({
    status: 'ok',
    message: 'Server is running',
    uptime: `${uptime}s`,
    timestamp: new Date().toISOString(),
    dataInitialized: true,
    environment: 'self-hosted'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Ship Cleaning GIS API Server',
    version: '2.0.0',
    endpoints: [
      '/api/portAuthorities',
      '/api/marineParks',
      '/api/fishHabitat',
      '/api/cockburnSound',
      '/api/mooringAreas',
      '/api/marineInfrastructure',
      '/api/bathymetry',
      '/api/recommendedZones',
      '/api/constraintData',
      '/api/coastline',
      '/api/zoneCalculationStatus',
      '/api/dataStatus',
      '/api/clearCache',
      '/healthcheck'
    ]
  });
});

// Perform zone calculation
async function performZoneCalculation() {
  // Add timeout to prevent hanging
  const timeout = setTimeout(() => {
    console.error('Zone calculation timed out after 10 minutes');
    zoneCalculationStatus.inProgress = false;
    zoneCalculationStatus.error = 'Calculation timed out after 10 minutes';
  }, 10 * 60 * 1000); // 10 minutes timeout
  
  try {
    console.log('Starting zone calculation...');
    
    // Get all constraint data
    const constraintData = await dataManager.getAllData();
    constraintData.coastline = ENHANCED_COASTLINE;
    constraintData.studyArea = STUDY_AREA;
    
    // Calculate zones
    const result = await zoneCalculator.calculateRecommendedZones(constraintData, {
      progressCallback: (progress, message) => {
        zoneCalculationStatus.progress = progress;
        console.log(`Zone calculation: ${progress}% - ${message}`);
      }
    });
    
    clearTimeout(timeout);
    zoneCalculationStatus.inProgress = false;
    zoneCalculationStatus.lastCompleted = new Date().toISOString();
    zoneCalculationStatus.progress = 100;
    
    console.log('Zone calculation completed successfully');
  } catch (error) {
    clearTimeout(timeout);
    console.error('Zone calculation failed:', error);
    zoneCalculationStatus.inProgress = false;
    zoneCalculationStatus.error = error.message;
  }
}

// Fallback bathymetry data
function getFrementleBathymetryFallback() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { depth: 5, name: '5m Depth Contour' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.735, -32.045],
            [115.739, -32.048],
            [115.742, -32.052],
            [115.745, -32.056],
            [115.748, -32.060],
            [115.745, -32.065],
            [115.740, -32.070],
            [115.735, -32.075]
          ]
        }
      },
      {
        type: 'Feature',
        properties: { depth: 10, name: '10m Depth Contour' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.725, -32.040],
            [115.729, -32.043],
            [115.732, -32.047],
            [115.735, -32.051],
            [115.738, -32.055],
            [115.735, -32.060],
            [115.730, -32.065],
            [115.725, -32.070]
          ]
        }
      },
      {
        type: 'Feature',
        properties: { depth: 15, name: '15m Depth Contour' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.715, -32.035],
            [115.719, -32.038],
            [115.722, -32.042],
            [115.725, -32.046],
            [115.728, -32.050],
            [115.725, -32.055],
            [115.720, -32.060],
            [115.715, -32.065]
          ]
        }
      },
      {
        type: 'Feature',
        properties: { depth: 20, name: '20m Depth Contour' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [115.705, -32.030],
            [115.709, -32.033],
            [115.712, -32.037],
            [115.715, -32.041],
            [115.718, -32.045],
            [115.715, -32.050],
            [115.710, -32.055],
            [115.705, -32.060]
          ]
        }
      }
    ],
    metadata: {
      source: 'fallback',
      description: 'Bathymetry reference data',
      generated: new Date().toISOString()
    }
  };
}

// Export constants for use in other modules
module.exports.ENHANCED_COASTLINE = ENHANCED_COASTLINE;
module.exports.STUDY_AREA = STUDY_AREA;

// Initialize and start server
async function startServer() {
  try {
    // Initialize data manager and zone calculator
    await dataManager.initialize();
    await zoneCalculator.initialize();
    
    console.log('Data manager and zone calculator initialized');
    
    // Start the server
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
      console.log(`API endpoints available at http://localhost:${port}/api/`);
      console.log('\nNOTE: Run "npm run init-data" to download and cache all GIS data');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer(); 