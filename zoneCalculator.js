const fs = require('fs').promises;
const path = require('path');
const turf = require('@turf/turf');
const crypto = require('crypto');

class ZoneCalculator {
  constructor(options = {}) {
    this.zonesDir = options.zonesDir || path.join(__dirname, 'calculated_zones');
    this.cacheDir = options.cacheDir || path.join(__dirname, 'zone_cache');
    this.gridResolution = options.gridResolution || 0.005; // ~500m grid
    this.bufferSize = options.bufferSize || 0.001; // ~100m buffer
  }

  async initialize() {
    await fs.mkdir(this.zonesDir, { recursive: true });
    await fs.mkdir(this.cacheDir, { recursive: true });
    console.log('Zone calculator initialized');
  }

  async calculateRecommendedZones(constraintData, options = {}) {
    const startTime = Date.now();
    const progressCallback = options.progressCallback || (() => {});
    
    try {
      // Generate a hash of the input constraints to check cache
      const constraintHash = this.generateConstraintHash(constraintData);
      const cacheKey = `zones_${constraintHash}_${this.gridResolution}`;
      
      // Check if we have cached results
      const cachedResult = await this.getCachedResult(cacheKey);
      if (cachedResult && !options.forceRecalculate) {
        console.log('Using cached zone calculation');
        progressCallback(100, 'Using cached results');
        return cachedResult;
      }

      console.log('Starting zone calculation...');
      progressCallback(5, 'Initializing calculation');

      // Extract study area bounds
      const studyArea = constraintData.studyArea || this.getDefaultStudyArea();
      const bbox = turf.bbox(studyArea);
      
      progressCallback(10, 'Creating water mask');
      
      // Create comprehensive land exclusion
      const landFeatures = this.extractLandFeatures(constraintData);
      const waterMask = await this.createWaterMask(studyArea, landFeatures);
      
      progressCallback(20, 'Processing constraints');
      
      // Collect all constraint features
      const constraints = await this.collectConstraints(constraintData);
      
      progressCallback(30, 'Building spatial index');
      
      // Create spatial index for faster lookups
      const spatialIndex = this.buildSpatialIndex(constraints);
      
      progressCallback(40, 'Generating candidate points');
      
      // Generate grid of test points using adaptive resolution
      const candidatePoints = await this.generateAdaptiveGrid(bbox, waterMask, spatialIndex, progressCallback);
      
      progressCallback(70, 'Creating zones from valid points');
      
      // Create zones from valid points
      const zones = await this.createZonesFromPoints(candidatePoints, progressCallback);
      
      progressCallback(85, 'Optimizing zone boundaries');
      
      // Optimize and clean zones
      const optimizedZones = await this.optimizeZones(zones, waterMask, landFeatures);
      
      progressCallback(95, 'Finalizing results');
      
      // Create result
      const result = {
        type: 'FeatureCollection',
        features: optimizedZones.map((zone, index) => ({
          type: 'Feature',
          properties: {
            id: `zone_${index + 1}`,
            type: 'Potential Cleaning Zone',
            area: turf.area(zone),
            perimeter: turf.length(zone, { units: 'kilometers' }),
            description: 'Area suitable for in-water hull cleaning',
            calculatedAt: new Date().toISOString(),
            method: 'optimized-grid',
            gridResolution: this.gridResolution
          },
          geometry: zone.geometry
        })),
        metadata: {
          calculationTime: Date.now() - startTime,
          totalCandidatePoints: candidatePoints.length,
          constraintsProcessed: constraints.length,
          gridResolution: this.gridResolution
        }
      };

      // Cache the result
      await this.cacheResult(cacheKey, result);
      
      // Save to file
      const filename = `zones_${new Date().toISOString().split('T')[0]}.json`;
      await fs.writeFile(
        path.join(this.zonesDir, filename),
        JSON.stringify(result, null, 2)
      );
      
      progressCallback(100, 'Calculation complete');
      console.log(`Zone calculation completed in ${Date.now() - startTime}ms`);
      
      return result;
    } catch (error) {
      console.error('Zone calculation failed:', error);
      throw error;
    }
  }

  async generateAdaptiveGrid(bbox, waterMask, spatialIndex, progressCallback) {
    const points = [];
    const [minX, minY, maxX, maxY] = bbox;
    
    // Use coarser grid initially
    const coarseResolution = this.gridResolution * 2;
    let processedCells = 0;
    const totalCells = Math.ceil((maxX - minX) / coarseResolution) * 
                      Math.ceil((maxY - minY) / coarseResolution);
    
    for (let x = minX; x <= maxX; x += coarseResolution) {
      for (let y = minY; y <= maxY; y += coarseResolution) {
        processedCells++;
        
        if (processedCells % 100 === 0) {
          const progress = 40 + Math.floor((processedCells / totalCells) * 25);
          progressCallback(progress, `Processing grid (${points.length} valid points found)`);
        }
        
        const point = turf.point([x, y]);
        
        // Quick check if point is in water
        if (!turf.booleanPointInPolygon(point, waterMask)) {
          continue;
        }
        
        // Check if point is in any constraint using spatial index
        const nearbyConstraints = this.queryNearbyFeatures(spatialIndex, point, coarseResolution);
        let inConstraint = false;
        
        for (const constraint of nearbyConstraints) {
          if (turf.booleanPointInPolygon(point, constraint)) {
            inConstraint = true;
            break;
          }
        }
        
        if (!inConstraint) {
          points.push(point);
          
          // Add finer resolution around valid points
          if (this.gridResolution < coarseResolution) {
            const finePoints = this.generateFineGrid(
              x - coarseResolution/2, 
              y - coarseResolution/2,
              x + coarseResolution/2,
              y + coarseResolution/2,
              waterMask,
              spatialIndex
            );
            points.push(...finePoints);
          }
        }
      }
    }
    
    return points;
  }

  generateFineGrid(minX, minY, maxX, maxY, waterMask, spatialIndex) {
    const finePoints = [];
    
    for (let x = minX; x <= maxX; x += this.gridResolution) {
      for (let y = minY; y <= maxY; y += this.gridResolution) {
        const point = turf.point([x, y]);
        
        if (!turf.booleanPointInPolygon(point, waterMask)) {
          continue;
        }
        
        const nearbyConstraints = this.queryNearbyFeatures(spatialIndex, point, this.gridResolution);
        let inConstraint = false;
        
        for (const constraint of nearbyConstraints) {
          if (turf.booleanPointInPolygon(point, constraint)) {
            inConstraint = true;
            break;
          }
        }
        
        if (!inConstraint) {
          finePoints.push(point);
        }
      }
    }
    
    return finePoints;
  }

  async createZonesFromPoints(points, progressCallback) {
    if (points.length === 0) {
      throw new Error('No valid points found for zone creation');
    }
    
    // Create buffers around points
    const buffers = [];
    const batchSize = 100;
    
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, Math.min(i + batchSize, points.length));
      const batchBuffers = batch.map(point => 
        turf.buffer(point, this.bufferSize, { units: 'degrees', steps: 6 })
      );
      buffers.push(...batchBuffers);
      
      const progress = 70 + Math.floor((i / points.length) * 10);
      progressCallback(progress, `Creating zones (${i}/${points.length} points processed)`);
    }
    
    // Merge nearby buffers using clustering
    const clusters = this.clusterPolygons(buffers);
    const zones = [];
    
    for (const cluster of clusters) {
      try {
        let merged = cluster[0];
        for (let i = 1; i < cluster.length; i++) {
          merged = turf.union(merged, cluster[i]);
        }
        zones.push(merged);
      } catch (error) {
        console.warn('Error merging cluster:', error);
      }
    }
    
    return zones;
  }

  clusterPolygons(polygons, maxDistance = 0.001) {
    const clusters = [];
    const processed = new Set();
    
    for (let i = 0; i < polygons.length; i++) {
      if (processed.has(i)) continue;
      
      const cluster = [polygons[i]];
      processed.add(i);
      
      // Find all polygons that should be in this cluster
      const queue = [i];
      
      while (queue.length > 0) {
        const current = queue.shift();
        
        for (let j = 0; j < polygons.length; j++) {
          if (processed.has(j)) continue;
          
          // Check if polygons are close enough
          const distance = turf.distance(
            turf.centroid(polygons[current]), 
            turf.centroid(polygons[j])
          );
          
          if (distance <= maxDistance || turf.booleanOverlap(polygons[current], polygons[j])) {
            cluster.push(polygons[j]);
            processed.add(j);
            queue.push(j);
          }
        }
      }
      
      clusters.push(cluster);
    }
    
    return clusters;
  }

  async optimizeZones(zones, waterMask, landFeatures) {
    const optimized = [];
    
    for (const zone of zones) {
      try {
        // Ensure zone is within water mask
        let clipped = turf.intersect(zone, waterMask);
        if (!clipped) continue;
        
        // Remove any land overlaps
        for (const land of landFeatures) {
          try {
            clipped = turf.difference(clipped, land);
            if (!clipped) break;
          } catch (error) {
            // Continue if difference fails
          }
        }
        
        if (!clipped) continue;
        
        // Simplify the zone boundary
        const simplified = turf.simplify(clipped, { 
          tolerance: 0.0001, 
          highQuality: true 
        });
        
        // Only keep zones with significant area (> 0.1 sq km)
        const area = turf.area(simplified) / 1000000; // Convert to sq km
        if (area > 0.1) {
          optimized.push(simplified);
        }
      } catch (error) {
        console.warn('Error optimizing zone:', error);
      }
    }
    
    return optimized;
  }

  buildSpatialIndex(features) {
    // Simple grid-based spatial index
    const index = new Map();
    const cellSize = 0.01; // ~1km cells
    
    for (const feature of features) {
      const bbox = turf.bbox(feature);
      const minCellX = Math.floor(bbox[0] / cellSize);
      const minCellY = Math.floor(bbox[1] / cellSize);
      const maxCellX = Math.ceil(bbox[2] / cellSize);
      const maxCellY = Math.ceil(bbox[3] / cellSize);
      
      for (let x = minCellX; x <= maxCellX; x++) {
        for (let y = minCellY; y <= maxCellY; y++) {
          const key = `${x},${y}`;
          if (!index.has(key)) {
            index.set(key, []);
          }
          index.get(key).push(feature);
        }
      }
    }
    
    return index;
  }

  queryNearbyFeatures(spatialIndex, point, radius) {
    const features = new Set();
    const cellSize = 0.01;
    const [lng, lat] = point.geometry.coordinates;
    
    const cellX = Math.floor(lng / cellSize);
    const cellY = Math.floor(lat / cellSize);
    const cellRadius = Math.ceil(radius / cellSize);
    
    for (let x = cellX - cellRadius; x <= cellX + cellRadius; x++) {
      for (let y = cellY - cellRadius; y <= cellY + cellRadius; y++) {
        const key = `${x},${y}`;
        const cellFeatures = spatialIndex.get(key) || [];
        cellFeatures.forEach(f => features.add(f));
      }
    }
    
    return Array.from(features);
  }

  extractLandFeatures(constraintData) {
    const landFeatures = [];
    
    if (constraintData.coastline?.features) {
      landFeatures.push(...constraintData.coastline.features);
    }
    
    // Add any other land-type features
    const landTypes = ['land', 'island', 'peninsula'];
    
    for (const [key, data] of Object.entries(constraintData)) {
      if (data?.features) {
        const lands = data.features.filter(f => 
          f.properties && landTypes.some(type => 
            f.properties.type?.toLowerCase().includes(type) ||
            f.properties.name?.toLowerCase().includes(type)
          )
        );
        landFeatures.push(...lands);
      }
    }
    
    return landFeatures;
  }

  async createWaterMask(studyArea, landFeatures) {
    let waterMask = studyArea;
    
    // Create union of all land features
    if (landFeatures.length > 0) {
      let landUnion = landFeatures[0];
      
      for (let i = 1; i < landFeatures.length; i++) {
        try {
          landUnion = turf.union(landUnion, landFeatures[i]);
        } catch (error) {
          console.warn('Error unioning land feature:', error);
        }
      }
      
      // Buffer land slightly to ensure clean boundaries
      const bufferedLand = turf.buffer(landUnion, 0.0005, { units: 'degrees' });
      
      // Subtract land from study area
      try {
        waterMask = turf.difference(studyArea, bufferedLand);
      } catch (error) {
        console.error('Error creating water mask:', error);
      }
    }
    
    return waterMask;
  }

  async collectConstraints(constraintData) {
    const constraints = [];
    
    const constraintKeys = [
      'portAuthorities',
      'marineParks',
      'fishHabitat',
      'cockburnSound',
      'mooringAreas',
      'marineInfrastructure',
      'marineGeomorphic',
      'ausMarineParks',
      'osmHarbours',
      'osmMarinas'
    ];
    
    for (const key of constraintKeys) {
      if (constraintData[key]?.features) {
        const polygons = constraintData[key].features.filter(f =>
          f.geometry && 
          (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
        );
        constraints.push(...polygons);
      }
    }
    
    return constraints;
  }

  generateConstraintHash(constraintData) {
    const summary = {
      keys: Object.keys(constraintData).sort(),
      featureCounts: {}
    };
    
    for (const [key, data] of Object.entries(constraintData)) {
      if (data?.features) {
        summary.featureCounts[key] = data.features.length;
      }
    }
    
    return crypto.createHash('md5')
      .update(JSON.stringify(summary))
      .digest('hex')
      .substring(0, 8);
  }

  async getCachedResult(cacheKey) {
    try {
      const cachePath = path.join(this.cacheDir, `${cacheKey}.json`);
      const data = await fs.readFile(cachePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  async cacheResult(cacheKey, result) {
    try {
      const cachePath = path.join(this.cacheDir, `${cacheKey}.json`);
      await fs.writeFile(cachePath, JSON.stringify(result, null, 2));
    } catch (error) {
      console.warn('Failed to cache result:', error);
    }
  }

  getDefaultStudyArea() {
    return {
      type: 'Feature',
      properties: {
        type: 'Study Area',
        description: 'Default study area - Western Australia coast'
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
  }

  async getLatestZones() {
    try {
      const files = await fs.readdir(this.zonesDir);
      const zoneFiles = files.filter(f => f.startsWith('zones_') && f.endsWith('.json'));
      
      if (zoneFiles.length === 0) {
        return null;
      }
      
      // Sort by date (newest first)
      zoneFiles.sort().reverse();
      
      const latestFile = path.join(this.zonesDir, zoneFiles[0]);
      const data = await fs.readFile(latestFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error getting latest zones:', error);
      return null;
    }
  }
}

module.exports = ZoneCalculator; 