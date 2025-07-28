# Ship Cleaning Locator GIS

A comprehensive GIS application for identifying suitable locations for in-water hull cleaning activities in Western Australia, with a focus on the Fremantle area.

## Features

- **Interactive Map**: Visualize marine constraints and potential cleaning zones
- **Local Data Caching**: All GIS data is cached locally for improved performance
- **Optimized Zone Calculation**: Pre-calculated potential cleaning zones using advanced algorithms
- **Modern UI**: Clean, responsive interface with material design principles
- **Multiple Data Sources**: Integrates data from WA government, OpenStreetMap, and Australian government sources
- **Real-time Analysis**: Click anywhere on the map to analyze location suitability
- **Offline Support**: Works without internet connection once data is initialized

## Constraints Considered

- Port Authority Areas
- Marine Parks & Reserves  
- Fish Habitat Protection Areas
- Cockburn Sound Protection Area
- Mooring Control Areas
- Marine Infrastructure
- Bathymetry (depth contours)
- Coastline boundaries

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/ShipCleaningLocatorGIS.git
cd ShipCleaningLocatorGIS
```

2. Install dependencies:
```bash
npm install
```

3. Initialize GIS data (downloads and caches all data locally):
```bash
npm run init-data
```

This will download approximately 50-100MB of GIS data and pre-calculate optimal cleaning zones.

4. Start the server:
```bash
npm start
```

5. Open your browser and navigate to `http://localhost:3000`

## Usage

### Finding Suitable Cleaning Locations

1. The map will display with all constraint layers visible
2. Purple areas indicate "Potential Cleaning Zones" - areas suitable for hull cleaning
3. Click anywhere on the map to analyze a specific location
4. The analysis will show:
   - Whether the location is in water
   - Distance to nearest constraints
   - Whether it's in a recommended zone
   - Proximity to navigation references

### Managing Layers

- Use the checkboxes in the sidebar to toggle different constraint layers
- The legend shows the color coding for each layer type
- Bathymetry contours show water depth

### Updating Data

- Click "Update Data" in the sidebar to refresh GIS data from sources
- Run `npm run update-data` to update via command line

## Data Sources

- **WA Government**: Port authorities, marine parks, fish habitats, mooring areas
- **OpenStreetMap**: Harbours and marinas
- **Australian Government**: National marine parks
- **GEBCO**: Bathymetry data

## Technical Details

### Architecture

- **Backend**: Node.js with Express
- **Frontend**: Leaflet.js with Turf.js for GIS operations
- **Data Storage**: Local file-based caching
- **Zone Calculation**: Optimized grid-based algorithm with spatial indexing

### Performance Optimizations

- Pre-calculated cleaning zones stored locally
- Adaptive grid resolution for efficient computation
- Spatial indexing for fast constraint lookups
- Local data caching eliminates API dependencies

## Development

### Running in Development Mode
```bash
npm run dev
```

### Project Structure
```
ShipCleaningLocatorGIS/
├── server.js           # Main server file
├── dataManager.js      # Handles GIS data downloading and caching
├── zoneCalculator.js   # Calculates optimal cleaning zones
├── public/            
│   ├── index.html      # Frontend application
│   └── css/
│       └── modern-ui.css # Modern UI styles
├── gis_data/          # Cached GIS data (created on init)
├── calculated_zones/   # Pre-calculated zones
├── fallback_data/     # Fallback data for offline use
└── scripts/
    └── initializeData.js # Data initialization script
```

## Deployment

For self-hosting on your own server:

1. Ensure Node.js 14+ is installed
2. Clone the repository to your server
3. Run `npm install --production`
4. Run `npm run init-data` to download all GIS data
5. Set up a process manager like PM2:
   ```bash
   npm install -g pm2
   pm2 start server.js --name ship-cleaning-gis
   pm2 save
   pm2 startup
   ```
6. Configure a reverse proxy (nginx/Apache) to serve the application

## License

MIT License

## Contact

For questions or issues, please open an issue on GitHub.
