const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const turf = require('@turf/turf');
const crypto = require('crypto');

class DataManager {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, 'gis_data');
    this.fallbackDir = options.fallbackDir || path.join(__dirname, 'fallback_data');
    this.refreshInterval = options.refreshInterval || 24 * 60 * 60 * 1000; // 24 hours
    this.sources = this.initializeDataSources();
    this.lastRefresh = {};
  }

  initializeDataSources() {
    return {
      // Western Australia government sources
      portAuthorities: {
        url: "https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Boundaries/MapServer/12/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
        description: "Port Authority Areas",
        priority: 1
      },
      marineParks: {
        url: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/2/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
        description: "Marine Parks & Reserves",
        priority: 1
      },
      fishHabitat: {
        url: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/4/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
        description: "Fish Habitat Protection Areas",
        priority: 1
      },
      cockburnSound: {
        url: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/12/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
        description: "Cockburn Sound Protection Area",
        priority: 1
      },
      mooringAreas: {
        url: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/15/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
        description: "Mooring Control Areas",
        priority: 2
      },
      marineInfrastructure: {
        url: "https://services.slip.wa.gov.au/public/rest/services/Landgate_Public_Maps/Marine_Map_WA_3/MapServer/18/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson",
        description: "Marine Infrastructure",
        priority: 2
      },
      
      // Additional sources - OpenStreetMap
      osmHarbours: {
        url: "https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];(way[\"harbour\"=\"yes\"](around:50000,-32.05,115.73);relation[\"harbour\"=\"yes\"](around:50000,-32.05,115.73););out%20geom;",
        description: "OSM Harbour Areas",
        priority: 3,
        parser: 'osm'
      },
      osmMarinas: {
        url: "https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];(way[\"leisure\"=\"marina\"](around:50000,-32.05,115.73);relation[\"leisure\"=\"marina\"](around:50000,-32.05,115.73););out%20geom;",
        description: "OSM Marina Areas",
        priority: 3,
        parser: 'osm'
      },
      
      // Australian Government sources
      ausMarineParks: {
        url: "https://services1.arcgis.com/VAI453sU9tG9rSmh/ArcGIS/rest/services/Australian_Marine_Parks/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&geometry=%7B%22xmin%22%3A115.2%2C%22ymin%22%3A-32.6%2C%22xmax%22%3A116.0%2C%22ymax%22%3A-30.9%2C%22spatialReference%22%3A%7B%22wkid%22%3A4326%7D%7D&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects",
        description: "Australian Marine Parks",
        priority: 2
      },
      
      // GEBCO Bathymetry
      gebcoBathymetry: {
        url: "https://www.gebco.net/data_and_products/gebco_web_services/web_map_service/mapserv?request=getfeature&service=wfs&version=2.0.0&typenames=gebco:gebco_2023_contours&outputformat=application/json&bbox=115.2,-32.6,116.0,-30.9,EPSG:4326",
        description: "GEBCO Bathymetry Contours",
        priority: 3
      },
      
      // Marine Geomorphic Features (commented out due to API issues)
      // marineGeomorphic: {
      //   url: "https://services.ga.gov.au/gis/rest/services/Geomorphic_Features_Australia_Marine_Jurisdiction/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&geometry=%7B%22xmin%22%3A115.2%2C%22ymin%22%3A-32.6%2C%22xmax%22%3A116.0%2C%22ymax%22%3A-30.9%2C%22spatialReference%22%3A%7B%22wkid%22%3A4326%7D%7D&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects",
      //   description: "Marine Geomorphic Features",
      //   priority: 2
      // }
    };
  }

  async initialize() {
    try {
      // Create data directories
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.mkdir(this.fallbackDir, { recursive: true });
      
      console.log(`Data directories created: ${this.dataDir}, ${this.fallbackDir}`);
      
      // Load metadata about last refresh times
      try {
        const metadataPath = path.join(this.dataDir, 'metadata.json');
        const metadata = await fs.readFile(metadataPath, 'utf8');
        this.lastRefresh = JSON.parse(metadata);
      } catch (error) {
        // No metadata yet
        this.lastRefresh = {};
      }
      
      return true;
    } catch (error) {
      console.error('Failed to initialize DataManager:', error);
      throw error;
    }
  }

  async downloadAndStoreData(key, forceRefresh = false) {
    const source = this.sources[key];
    if (!source) {
      throw new Error(`Unknown data source: ${key}`);
    }

    const dataPath = path.join(this.dataDir, `${key}.json`);
    const lastRefreshTime = this.lastRefresh[key] || 0;
    const now = Date.now();

    // Check if we need to refresh
    if (!forceRefresh && (now - lastRefreshTime) < this.refreshInterval) {
      try {
        const data = await fs.readFile(dataPath, 'utf8');
        return JSON.parse(data);
      } catch (error) {
        console.log(`Local data for ${key} not found, downloading...`);
      }
    }

    console.log(`Downloading data for ${key} from ${source.url}`);
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout
      
      const response = await fetch(source.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ShipCleaningGIS/1.0',
          'Accept': 'application/json, application/geo+json'
        }
      });
      
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      let data = await response.json();
      
      // Parse different data formats
      if (source.parser === 'osm') {
        data = this.parseOSMData(data);
      }
      
      // Validate GeoJSON
      if (!this.isValidGeoJSON(data)) {
        throw new Error('Invalid GeoJSON response');
      }

      // Clean and optimize the data
      data = this.cleanupGeoJSON(data);
      
      // Calculate hash for change detection
      const dataHash = crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
      
      // Store the data
      await fs.writeFile(dataPath, JSON.stringify(data, null, 2));
      
      // Update metadata
      this.lastRefresh[key] = now;
      this.lastRefresh[`${key}_hash`] = dataHash;
      await this.saveMetadata();
      
      console.log(`Successfully downloaded and stored ${key} (${data.features?.length || 0} features)`);
      
      // Also save to fallback directory
      const fallbackPath = path.join(this.fallbackDir, `${key}.json`);
      await fs.writeFile(fallbackPath, JSON.stringify(data, null, 2));
      
      return data;
    } catch (error) {
      console.error(`Failed to download ${key}:`, error);
      
      // Try to load from fallback
      try {
        const fallbackPath = path.join(this.fallbackDir, `${key}.json`);
        const fallbackData = await fs.readFile(fallbackPath, 'utf8');
        console.log(`Using fallback data for ${key}`);
        return JSON.parse(fallbackData);
      } catch (fallbackError) {
        console.error(`No fallback data available for ${key}`);
        throw error;
      }
    }
  }

  async downloadAllData(forceRefresh = false) {
    const results = {};
    const errors = [];
    
    // Sort by priority
    const sortedKeys = Object.keys(this.sources).sort((a, b) => 
      (this.sources[a].priority || 999) - (this.sources[b].priority || 999)
    );
    
    for (const key of sortedKeys) {
      try {
        results[key] = await this.downloadAndStoreData(key, forceRefresh);
        // Add delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        errors.push({ key, error: error.message });
        results[key] = { type: 'FeatureCollection', features: [] };
      }
    }
    
    if (errors.length > 0) {
      console.warn('Some data sources failed:', errors);
    }
    
    return { results, errors };
  }

  async getData(key) {
    const dataPath = path.join(this.dataDir, `${key}.json`);
    
    try {
      const data = await fs.readFile(dataPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      // Try to download if not available
      console.log(`Data for ${key} not found locally, attempting download...`);
      return await this.downloadAndStoreData(key);
    }
  }

  async getAllData() {
    const data = {};
    
    for (const key of Object.keys(this.sources)) {
      try {
        data[key] = await this.getData(key);
      } catch (error) {
        console.error(`Failed to get data for ${key}:`, error);
        data[key] = { type: 'FeatureCollection', features: [] };
      }
    }
    
    return data;
  }

  async checkForUpdates() {
    const updates = [];
    
    for (const [key, source] of Object.entries(this.sources)) {
      const lastRefreshTime = this.lastRefresh[key] || 0;
      const age = Date.now() - lastRefreshTime;
      
      if (age > this.refreshInterval) {
        updates.push({
          key,
          description: source.description,
          lastRefresh: new Date(lastRefreshTime).toISOString(),
          age: Math.floor(age / 1000 / 60 / 60) + ' hours'
        });
      }
    }
    
    return updates;
  }

  async saveMetadata() {
    const metadataPath = path.join(this.dataDir, 'metadata.json');
    await fs.writeFile(metadataPath, JSON.stringify(this.lastRefresh, null, 2));
  }

  parseOSMData(osmData) {
    const features = [];
    
    if (osmData.elements) {
      for (const element of osmData.elements) {
        if (element.type === 'way' && element.geometry) {
          const coordinates = element.geometry.map(node => [node.lon, node.lat]);
          features.push({
            type: 'Feature',
            properties: element.tags || {},
            geometry: {
              type: 'LineString',
              coordinates
            }
          });
        } else if (element.type === 'relation' && element.members) {
          // Handle relations (usually multipolygons)
          // This is simplified - proper OSM relation parsing is complex
          const properties = element.tags || {};
          features.push({
            type: 'Feature',
            properties,
            geometry: {
              type: 'MultiPolygon',
              coordinates: [] // Would need proper parsing
            }
          });
        }
      }
    }
    
    return {
      type: 'FeatureCollection',
      features
    };
  }

  isValidGeoJSON(data) {
    if (!data || typeof data !== 'object') return false;
    
    if (data.type === "FeatureCollection") {
      return Array.isArray(data.features);
    }
    
    if (data.type === "Feature") {
      return data.geometry && data.geometry.type;
    }
    
    return ["Point", "LineString", "Polygon", "MultiPoint", 
            "MultiLineString", "MultiPolygon", "GeometryCollection"].includes(data.type);
  }

  cleanupGeoJSON(data) {
    if (!data || !data.type) return data;
    
    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
      // Filter out invalid features and simplify
      const validFeatures = data.features
        .filter(feature => {
          if (!feature || feature.type !== 'Feature' || !feature.geometry || !feature.geometry.type) {
            return false;
          }
          
          const validTypes = ["Point", "LineString", "Polygon", "MultiPoint", 
                            "MultiLineString", "MultiPolygon"];
          if (!validTypes.includes(feature.geometry.type)) {
            return false;
          }
          
          if (!Array.isArray(feature.geometry.coordinates) || 
              feature.geometry.coordinates.length === 0) {
            return false;
          }
          
          return true;
        })
        .map(feature => {
          // Simplify geometry if it's complex
          try {
            if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
              const simplified = turf.simplify(feature, { tolerance: 0.0001, highQuality: false });
              return simplified;
            }
          } catch (error) {
            // If simplification fails, return original
          }
          return feature;
        });
      
      return {
        type: 'FeatureCollection',
        features: validFeatures,
        ...(data.crs ? { crs: data.crs } : {})
      };
    }
    
    return data;
  }

  async getDataStatus() {
    const status = {};
    
    for (const [key, source] of Object.entries(this.sources)) {
      const dataPath = path.join(this.dataDir, `${key}.json`);
      const lastRefreshTime = this.lastRefresh[key] || 0;
      
      try {
        const stats = await fs.stat(dataPath);
        const data = await fs.readFile(dataPath, 'utf8');
        const parsed = JSON.parse(data);
        
        status[key] = {
          description: source.description,
          exists: true,
          size: stats.size,
          features: parsed.features?.length || 0,
          lastRefresh: new Date(lastRefreshTime).toISOString(),
          age: Math.floor((Date.now() - lastRefreshTime) / 1000 / 60 / 60) + ' hours',
          hash: this.lastRefresh[`${key}_hash`] || 'unknown'
        };
      } catch (error) {
        status[key] = {
          description: source.description,
          exists: false,
          error: error.message
        };
      }
    }
    
    return status;
  }
}

module.exports = DataManager; 