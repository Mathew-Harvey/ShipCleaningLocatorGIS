// server.js
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cors = require('cors');
const turf = require('@turf/turf');
const NodeCache = require('node-cache');

const app = express();
const port = process.env.PORT || 3000;
const dataCache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour

// Configure CORS to allow requests from your Netlify domain
app.use(cors({
  origin: ['http://localhost:3000', 'https://cleanmyship.netlify.app', 'https://shipcleaninggis-client.netlify.app'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.static('public'));
app.use(express.json());

// Configure API explorer with proper error handling
class APIExplorer {
  constructor(options = {}) {
    this.delayBetweenRequests = options.delayBetweenRequests || 1000;
    this.maxRetries = options.maxRetries || 3;
    this.commonHeaders = options.headers || {
      'x-api-key': '8f45eac321494fcbb5c38e116c841163' // OpenSea API key
    };
    this.timeout = options.timeout || 10000;
  }

  async rateLimitedFetch(url, options = {}) {
    let retries = 0;
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
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        return response;
      } catch (err) {
        retries++;
        console.warn(`Retry ${retries}/${this.maxRetries} for ${url}: ${err.message}`);
        
        if (retries === this.maxRetries) throw err;
        
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retries)));
      }
    }
  }

  async fetchGeoJSON(url) {
    try {
      // Check cache first
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
      
      // Clean up and repair the GeoJSON data
      const cleanedData = this.cleanupGeoJSON(data);
      
      // Cache the valid data
      dataCache.set(cacheKey, cleanedData);
      console.log(`Caching valid GeoJSON from: ${url}`);
      
      return cleanedData;
    } catch (err) {
      console.error(`Endpoint ${url} failed: ${err.message}`);
      throw err; // Re-throw to allow proper handling upstream
    }
  }
  
  cleanupGeoJSON(data) {
    if (!data || !data.type) return data;
    
    // Handle feature collections
    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
      // Filter out invalid features
      const validFeatures = data.features.filter(feature => {
        // Check if feature is not null and has a valid type
        if (!feature || feature.type !== 'Feature') return false;
        
        // Check if geometry exists
        if (!feature.geometry) return false;
        
        // Check geometry type
        const validTypes = ["Point", "LineString", "Polygon", "MultiPoint", 
                           "MultiLineString", "MultiPolygon", "GeometryCollection"];
        if (!validTypes.includes(feature.geometry.type)) return false;
        
        // Check geometry coordinates
        if (!Array.isArray(feature.geometry.coordinates)) return false;
        
        // For specific geometry types, perform deeper validation
        switch (feature.geometry.type) {
          case 'Point':
            return Array.isArray(feature.geometry.coordinates) && 
                  feature.geometry.coordinates.length >= 2 &&
                  typeof feature.geometry.coordinates[0] === 'number' &&
                  typeof feature.geometry.coordinates[1] === 'number';
            
          case 'LineString':
            return Array.isArray(feature.geometry.coordinates) && 
                  feature.geometry.coordinates.length >= 2 &&
                  feature.geometry.coordinates.every(coord => 
                    Array.isArray(coord) && coord.length >= 2 &&
                    typeof coord[0] === 'number' && typeof coord[1] === 'number'
                  );
            
          case 'Polygon':
            return Array.isArray(feature.geometry.coordinates) && 
                  feature.geometry.coordinates.length >= 1 &&
                  feature.geometry.coordinates.every(ring => 
                    Array.isArray(ring) && ring.length >= 4 &&
                    ring.every(coord => 
                      Array.isArray(coord) && coord.length >= 2 &&
                      typeof coord[0] === 'number' && typeof coord[1] === 'number'
                    )
                  );
            
          // For multi geometries and geometry collections, basic checks are enough
          default:
            return true;
        }
      });
      
      // Create cleaned feature collection
      return {
        type: 'FeatureCollection',
        features: validFeatures,
        ...(data.crs ? { crs: data.crs } : {}),  // Preserve CRS if it exists
      };
    }
    
    // No cleanup needed for other GeoJSON types
    return data;
  }

  isValidGeoJSON(data) {
    // More thorough validation
    if (!data || typeof data !== 'object') return false;
    
    // Check for FeatureCollection
    if (data.type === "FeatureCollection") {
      // Check if features array exists
      if (!Array.isArray(data.features)) return false;
      
      // Allow empty feature collections
      if (data.features.length === 0) return true;
      
      // Check a sample of features (not all, for performance with large datasets)
      const samplesToCheck = Math.min(data.features.length, 10);
      for (let i = 0; i < samplesToCheck; i++) {
        const feature = data.features[i];
        if (!feature || 
            feature.type !== "Feature" || 
            !feature.geometry) {
          console.warn(`Invalid feature at index ${i}:`, feature);
          // Continue checking other features
        }
      }
      
      // Return true even with some invalid features - we'll filter them later
      return true;
    }
    
    // Check for Feature
    if (data.type === "Feature") {
      return data.geometry && data.geometry.type;
    }
    
    // Check for Geometry
    return ["Point", "LineString", "Polygon", "MultiPoint", 
            "MultiLineString", "MultiPolygon", "GeometryCollection"]
            .includes(data.type);
  }
}

// Publicly available endpoints
const ENDPOINTS = {
  portAuthorities: "https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Boundaries/MapServer/12/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  marineParks: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/2/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  fishHabitat: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/4/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  cockburnSound: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/12/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  mooringAreas: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/15/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
  marineInfrastructure: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/18/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson"
};

// Create API endpoints for each documented service
Object.entries(ENDPOINTS).forEach(([key, url]) => {
  app.get(`/api/${key}`, async (req, res) => {
    try {
      const explorer = new APIExplorer({ 
        delayBetweenRequests: 500,
        timeout: 15000,
        maxRetries: 3
      });
      
      const data = await explorer.fetchGeoJSON(url);
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

// Define the study area boundary (around Fremantle)
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

// Define nautical reference points for the area
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

// New endpoint to calculate potential cleaning zones
// Replace the existing recommendedZones endpoint with this optimized version
app.get('/api/recommendedZones', async (req, res) => {
  try {
    // Check cache first
    const cacheKey = 'potential_cleaning_zones';
    const cachedZones = dataCache.get(cacheKey);
    
    if (cachedZones) {
      console.log('Using cached potential cleaning zones');
      return res.json(cachedZones);
    }
    
    console.log('Calculating potential cleaning zones...');
    
    // Set a timeout for this computation-heavy operation
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Calculation timed out')), 25000); // 25 second timeout
    });
    
    // Create the actual calculation promise
    const calculationPromise = (async () => {
      const explorer = new APIExplorer({ 
        delayBetweenRequests: 500,
        timeout: 15000,
        maxRetries: 3
      });
      
      // Fetch all constraint layers
      const constraints = {};
      for (const [key, url] of Object.entries(ENDPOINTS)) {
        try {
          constraints[key] = await explorer.fetchGeoJSON(url);
        } catch (error) {
          console.error(`Failed to fetch ${key}: ${error.message}`);
          // Continue with other constraints if one fails
        }
      }
      
      // Merge all constraint polygons
      let allConstraints = {
        type: 'FeatureCollection',
        features: []
      };
      
      // Process each layer
      Object.entries(constraints).forEach(([key, layer]) => {
        if (layer && layer.features) {
          console.log(`Processing ${key}: ${layer.features.length} features`);
          
          // Add only valid polygon features
          const validPolygons = layer.features.filter(feature => {
            try {
              if (!feature || !feature.geometry) return false;
              
              // Only include polygons and multipolygons
              if (feature.geometry.type !== 'Polygon' && 
                  feature.geometry.type !== 'MultiPolygon') {
                return false;
              }
              
              // For polygons, validate coordinate structure
              if (feature.geometry.type === 'Polygon') {
                return Array.isArray(feature.geometry.coordinates) && 
                      feature.geometry.coordinates.length > 0 &&
                      Array.isArray(feature.geometry.coordinates[0]) &&
                      feature.geometry.coordinates[0].length >= 4;
              }
              
              // For multipolygons, validate coordinate structure
              if (feature.geometry.type === 'MultiPolygon') {
                return Array.isArray(feature.geometry.coordinates) && 
                      feature.geometry.coordinates.length > 0 &&
                      Array.isArray(feature.geometry.coordinates[0]) &&
                      feature.geometry.coordinates[0].length > 0 &&
                      Array.isArray(feature.geometry.coordinates[0][0]) &&
                      feature.geometry.coordinates[0][0].length >= 4;
              }
              
              return false;
            } catch (e) {
              console.warn(`Invalid feature in ${key}:`, e.message);
              return false;
            }
          });
          
          console.log(`Found ${validPolygons.length} valid polygons in ${key}`);
          allConstraints.features.push(...validPolygons);
        }
      });
      
      // Union all constraint polygons if we have any
      let constraintUnion = null;
      
      if (allConstraints.features.length > 0) {
        try {
          console.log(`Unioning ${allConstraints.features.length} constraint features...`);
          
          // Process features in smaller batches to avoid memory issues
          const BATCH_SIZE = 10;
          let batchResults = [];
          
          // Process features in batches
          for (let i = 0; i < allConstraints.features.length; i += BATCH_SIZE) {
            const batch = allConstraints.features.slice(i, i + BATCH_SIZE);
            console.log(`Processing batch ${i/BATCH_SIZE + 1}/${Math.ceil(allConstraints.features.length/BATCH_SIZE)}`);
            
            let batchUnion = null;
            for (const feature of batch) {
              try {
                if (!batchUnion) {
                  batchUnion = feature;
                } else {
                  batchUnion = turf.union(batchUnion, feature);
                }
              } catch (e) {
                console.warn(`Union failed for a feature in batch, skipping:`, e.message);
              }
            }
            
            if (batchUnion) {
              batchResults.push(batchUnion);
            }
          }
          
          // Union the batch results
          constraintUnion = batchResults[0];
          for (let i = 1; i < batchResults.length; i++) {
            try {
              constraintUnion = turf.union(constraintUnion, batchResults[i]);
            } catch (e) {
              console.warn(`Union failed for batch result ${i}, skipping:`, e.message);
            }
          }
        } catch (error) {
          console.error('Error in turf.union:', error);
        }
      }
      
      // Calculate the difference between the study area and constraints
      let potentialZones;
      
      if (constraintUnion) {
        try {
          console.log('Calculating difference between study area and constraints...');
          potentialZones = turf.difference(STUDY_AREA, constraintUnion);
        } catch (error) {
          console.error('Error calculating difference:', error);
          potentialZones = STUDY_AREA; // Default to study area if calculation fails
        }
      } else {
        console.log('No valid constraints, using entire study area');
        potentialZones = STUDY_AREA; // Use entire study area if no constraints
      }
      
      // Create a feature collection for the result
      const result = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              type: 'Potential Cleaning Zone',
              description: 'Areas without constraint overlaps'
            },
            geometry: potentialZones.geometry
          }
        ]
      };
      
      // Cache the result
      dataCache.set(cacheKey, result, 7200); // Cache for 2 hours
      console.log('Potential cleaning zones calculated and cached');
      
      return result;
    })();
    
    // Race between calculation and timeout
    const result = await Promise.race([calculationPromise, timeoutPromise])
      .catch(error => {
        console.error('Error or timeout in zones calculation:', error.message);
        
        // If calculation times out or fails, return a simplified fallback zone
        return {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                type: 'Potential Cleaning Zone (Simplified)',
                description: 'Fallback cleaning zone - calculation timed out'
              },
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [115.65, -32.02],
                    [115.68, -32.02],
                    [115.68, -31.98],
                    [115.65, -31.98],
                    [115.65, -32.02]
                  ]
                ]
              }
            }
          ]
        };
      });
    
    res.json(result);
  } catch (error) {
    console.error('Error generating potential cleaning zones:', error);
    
    // Return a simplified fallback zone instead of an error
    res.json({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            type: 'Potential Cleaning Zone (Fallback)',
            description: 'Fallback cleaning zone due to server error'
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [115.65, -32.02],
                [115.68, -32.02],
                [115.68, -31.98],
                [115.65, -31.98],
                [115.65, -32.02]
              ]
            ]
          }
        }
      ]
    });
  }
});
    
    // Calculate the difference between the study area and constraints
    let potentialZones;
    
    if (constraintUnion) {
      try {
        console.log('Calculating difference between study area and constraints...');
        potentialZones = turf.difference(STUDY_AREA, constraintUnion);
      } catch (error) {
        console.error('Error calculating difference:', error);
        potentialZones = STUDY_AREA; // Default to study area if calculation fails
      }
    } else {
      console.log('No valid constraints, using entire study area');
      potentialZones = STUDY_AREA; // Use entire study area if no constraints
    }
    
    // Create a feature collection for the result
    const result = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            type: 'Potential Cleaning Zone',
            description: 'Areas without constraint overlaps'
          },
          geometry: potentialZones.geometry
        }
      ]
    };
    
    // Cache the result
    dataCache.set(cacheKey, result, 3600); // Cache for 1 hour
    console.log('Potential cleaning zones calculated and cached');
    
    res.json(result);
  } catch (error) {
    console.error('Error generating potential cleaning zones:', error);
    res.status(500).json({ 
      error: 'Error generating potential cleaning zones', 
      details: error.message 
    });
  }
});

// New endpoint for nautical information
app.get('/api/nauticalReferences', (req, res) => {
  try {
    res.json(NAUTICAL_REFERENCES);
  } catch (error) {
    console.error('Error providing nautical references:', error);
    res.status(500).json({ 
      error: 'Error providing nautical references', 
      details: error.message 
    });
  }
});

// New endpoint for proximity analysis
app.post('/api/analyzeProximity', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    
    if (!lat || !lng) {
      return res.status(400).json({ error: 'Missing coordinates' });
    }
    
    console.log(`Analyzing proximity for coordinates: ${lat}, ${lng}`);
    
    // Create a point feature from the coordinates
    const point = turf.point([parseFloat(lng), parseFloat(lat)]);
    
    // Fetch all constraint layers
    const explorer = new APIExplorer({ 
      delayBetweenRequests: 500,
      timeout: 15000,
      maxRetries: 3
    });
    
    const analysisResults = {};
    
    // Add nautical reference information
    analysisResults.nauticalReferences = {};
    
    try {
      // Find distances to nautical reference points
      NAUTICAL_REFERENCES.features.forEach(feature => {
        const distance = turf.distance(point, feature);
        const bearing = turf.bearing(point, feature);
        
        // Convert bearing to cardinal direction
        let bearingText = '';
        // Normalize bearing to 0-360
        const normalizedBearing = (bearing + 360) % 360;
        
        // Define cardinal directions
        const directions = [
          'N', 'NNE', 'NE', 'ENE', 
          'E', 'ESE', 'SE', 'SSE', 
          'S', 'SSW', 'SW', 'WSW', 
          'W', 'WNW', 'NW', 'NNW', 'N'
        ];
        
        // Find the corresponding cardinal direction
        const index = Math.round(normalizedBearing / 22.5);
        bearingText = directions[index];
        
        analysisResults.nauticalReferences[feature.properties.name] = {
          distance: distance.toFixed(2),
          bearing: bearing.toFixed(1),
          bearingText: bearingText,
          type: feature.properties.type,
          description: feature.properties.description
        };
      });
    } catch (err) {
      console.warn('Error calculating nautical references:', err.message);
    }
    
    // Analyze proximity to each constraint
    for (const [key, url] of Object.entries(ENDPOINTS)) {
      try {
        const data = await explorer.fetchGeoJSON(url);
        
        if (data && data.features && data.features.length > 0) {
          // Find the nearest feature
          let nearestFeature = null;
          let minDistance = Infinity;
          
          // Process features differently based on geometry type
          const validFeatures = data.features.filter(feature => 
            feature && feature.geometry && feature.geometry.type
          );
          
          // Process features one by one
          for (const feature of validFeatures) {
            try {
              let distance;
              
              // Handle different geometry types appropriately
              switch (feature.geometry.type) {
                case 'Point':
                  distance = turf.distance(point, feature);
                  break;
                  
                case 'LineString':
                  // For lines, calculate closest point on line
                  const closestPoint = turf.nearestPointOnLine(feature, point);
                  distance = closestPoint.properties.dist;
                  break;
                  
                case 'MultiLineString':
                  // Convert to line strings and find closest
                  let minLineDistance = Infinity;
                  feature.geometry.coordinates.forEach(lineCoords => {
                    const line = turf.lineString(lineCoords);
                    const closestOnLine = turf.nearestPointOnLine(line, point);
                    if (closestOnLine.properties.dist < minLineDistance) {
                      minLineDistance = closestOnLine.properties.dist;
                    }
                  });
                  distance = minLineDistance;
                  break;
                  
                case 'Polygon':
                case 'MultiPolygon':
                  // For polygons, check if point is inside first
                  const isInside = turf.booleanPointInPolygon(point, feature);
                  if (isInside) {
                    distance = 0; // Point is inside
                  } else {
                    // Calculate distance to boundary using explode to get boundary points
                    try {
                      // Convert polygon to points along boundary
                      const exploded = turf.explode(feature);
                      if (exploded && exploded.features.length) {
                        // Create a collection of boundary points
                        const boundaryPoints = turf.featureCollection(exploded.features);
                        // Find nearest point on boundary
                        const nearest = turf.nearestPoint(point, boundaryPoints);
                        distance = nearest.properties.distanceToPoint;
                      } else {
                        // Fallback: use center of polygon
                        const center = turf.center(feature);
                        distance = turf.distance(point, center);
                      }
                    } catch (e) {
                      console.warn(`Polygon distance calculation failed, using centroid for ${key}:`, e.message);
                      // Last resort: use centroid
                      const centroid = turf.centroid(feature);
                      distance = turf.distance(point, centroid);
                    }
                  }
                  break;
                  
                default:
                  // For geometries like GeometryCollection, use centroid as fallback
                  const centroid = turf.centroid(feature);
                  distance = turf.distance(point, centroid);
                  break;
              }
              
              // Update nearest feature if this one is closer
              if (distance < minDistance) {
                minDistance = distance;
                nearestFeature = feature;
              }
            } catch (e) {
              // Skip problematic features
              console.warn(`Distance calculation failed for a feature in ${key}:`, e.message);
            }
          }
          
          if (nearestFeature) {
            // Check if point is inside feature
            let pointInPolygon = false;
            
            try {
              if (nearestFeature.geometry.type === 'Polygon' || 
                  nearestFeature.geometry.type === 'MultiPolygon') {
                pointInPolygon = turf.booleanPointInPolygon(point, nearestFeature);
              }
            } catch (e) {
              console.warn(`Point-in-polygon test failed for ${key}:`, e.message);
            }
            
            // Store the result
            analysisResults[key] = {
              distance: minDistance.toFixed(2), // Distance in kilometers
              insideFeature: pointInPolygon,
              featureName: nearestFeature.properties?.NAME || 
                          nearestFeature.properties?.Name || 
                          nearestFeature.properties?.name || 
                          'Unnamed Feature',
              featureProperties: nearestFeature.properties
            };
          } else {
            analysisResults[key] = { 
              status: 'No valid features found for distance calculation' 
            };
          }
        } else {
          analysisResults[key] = { status: 'No features available' };
        }
      } catch (error) {
        console.error(`Failed to analyze proximity to ${key}:`, error);
        analysisResults[key] = { 
          error: 'Analysis failed', 
          details: error.message 
        };
      }
    }
    
    // Check if point is in a recommended zone
    try {
      // Use the local API for this to avoid cross-origin issues
      const recommendedZonesUrl = `${req.protocol}://${req.get('host')}/api/recommendedZones`;
      console.log(`Fetching recommended zones from: ${recommendedZonesUrl}`);
      
      const response = await fetch(recommendedZonesUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch recommended zones: ${response.statusText}`);
      }
      
      const recommendedZones = await response.json();
      
      if (recommendedZones && recommendedZones.features && recommendedZones.features.length > 0) {
        const isInRecommendedZone = recommendedZones.features.some(feature => {
          try {
            return turf.booleanPointInPolygon(point, feature);
          } catch (e) {
            console.warn('Point-in-polygon test failed for recommended zone:', e);
            return false;
          }
        });
        
        analysisResults.recommendedZone = {
          insideRecommendedZone: isInRecommendedZone
        };
      }
    } catch (error) {
      console.error('Failed to analyze proximity to recommended zones:', error);
      analysisResults.recommendedZone = { 
        error: 'Analysis failed', 
        details: error.message 
      };
    }
    
    const result = {
      coordinates: { lat, lng },
      results: analysisResults
    };
    
    console.log(`Analysis complete for coordinates: ${lat}, ${lng}`);
    res.json(result);
  } catch (error) {
    console.error('Error in proximity analysis:', error);
    res.status(500).json({ 
      error: 'Error performing proximity analysis', 
      details: error.message 
    });
  }
});

// Add a health check endpoint
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
      '/healthcheck'
    ]
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`API endpoints available at http://localhost:${port}/api/`);
});
