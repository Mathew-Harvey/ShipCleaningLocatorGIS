const DataManager = require('../dataManager');
const ZoneCalculator = require('../zoneCalculator');
const path = require('path');

async function initializeData() {
  console.log('=== Ship Cleaning GIS Data Initialization ===\n');
  
  // Initialize data manager
  const dataManager = new DataManager({
    dataDir: path.join(__dirname, '..', 'gis_data'),
    fallbackDir: path.join(__dirname, '..', 'fallback_data'),
    refreshInterval: 24 * 60 * 60 * 1000 // 24 hours
  });
  
  try {
    console.log('1. Initializing data manager...');
    await dataManager.initialize();
    
    console.log('\n2. Downloading all GIS data sources...');
    console.log('This may take several minutes depending on your internet connection.\n');
    
    const { results, errors } = await dataManager.downloadAllData(true); // Force refresh
    
    console.log('\n3. Data download summary:');
    console.log(`   - Total sources: ${Object.keys(dataManager.sources).length}`);
    console.log(`   - Successfully downloaded: ${Object.keys(results).length - errors.length}`);
    console.log(`   - Failed: ${errors.length}`);
    
    if (errors.length > 0) {
      console.log('\n   Failed sources:');
      errors.forEach(({ key, error }) => {
        console.log(`   - ${key}: ${error}`);
      });
    }
    
    console.log('\n4. Checking data status...');
    const status = await dataManager.getDataStatus();
    
    console.log('\n   Downloaded data:');
    for (const [key, info] of Object.entries(status)) {
      if (info.exists) {
        console.log(`   - ${key}: ${info.features} features (${(info.size / 1024).toFixed(1)} KB)`);
      }
    }
    
    console.log('\n5. Initializing zone calculator...');
    const zoneCalculator = new ZoneCalculator({
      zonesDir: path.join(__dirname, '..', 'calculated_zones'),
      cacheDir: path.join(__dirname, '..', 'zone_cache'),
      gridResolution: 0.005
    });
    
    await zoneCalculator.initialize();
    
    console.log('\n6. Pre-calculating recommended zones...');
    console.log('This may take a few minutes...\n');
    
    // Get all constraint data
    const constraintData = await dataManager.getAllData();
    
    // Add coastline data
    constraintData.coastline = require('../server-new').ENHANCED_COASTLINE;
    constraintData.studyArea = require('../server-new').STUDY_AREA;
    
    // Calculate zones with progress
    const zones = await zoneCalculator.calculateRecommendedZones(constraintData, {
      forceRecalculate: true,
      progressCallback: (progress, message) => {
        process.stdout.write(`\r   Progress: ${progress}% - ${message}`.padEnd(80));
      }
    });
    
    console.log('\n\n7. Zone calculation complete!');
    console.log(`   - Total zones: ${zones.features.length}`);
    console.log(`   - Calculation time: ${zones.metadata.calculationTime}ms`);
    console.log(`   - Candidate points processed: ${zones.metadata.totalCandidatePoints}`);
    
    console.log('\n=== Initialization Complete! ===');
    console.log('\nYour GIS data has been downloaded and cached locally.');
    console.log('The server will now use this local data instead of making external API calls.');
    console.log('\nTo update the data in the future, run this script again.');
    
  } catch (error) {
    console.error('\n❌ Initialization failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  initializeData().then(() => {
    process.exit(0);
  }).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { initializeData }; 