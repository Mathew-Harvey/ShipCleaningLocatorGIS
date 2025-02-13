// server.js
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));
app.use('/node_modules', express.static('node_modules'));

class APIExplorer {
  constructor(options = {}) {
    this.delayBetweenRequests = options.delayBetweenRequests || 1000;
    this.maxRetries = options.maxRetries || 3;
    this.commonHeaders = options.headers || {};
  }

  async rateLimitedFetch(url, options = {}) {
    let retries = 0;
    while (retries < this.maxRetries) {
      try {
        await new Promise(resolve => setTimeout(resolve, this.delayBetweenRequests));
        const response = await fetch(url, { 
          headers: this.commonHeaders, 
          ...options,
          timeout: 5000
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response;
      } catch (err) {
        retries++;
        if (retries === this.maxRetries) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }
    }
  }

  async fetchGeoJSON(url) {
    try {
      const response = await this.rateLimitedFetch(url);
      const data = await response.json();
      if (this.isValidGeoJSON(data)) {
        console.log(`Working endpoint found: ${url}`);
        return data;
      }
      throw new Error('Invalid GeoJSON response');
    } catch (err) {
      console.error(`Endpoint ${url} failed: ${err.message}`);
      return null;
    }
  }

  isValidGeoJSON(data) {
    return data &&
           data.type === "FeatureCollection" &&
           Array.isArray(data.features);
  }
}

// Publicly available endpoints (excluding shipChannels due to errors)
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
      const explorer = new APIExplorer({ delayBetweenRequests: 500 });
      const data = await explorer.fetchGeoJSON(url);
      if (data) {
        res.json(data);
      } else {
        res.status(404).json({ error: 'No valid data found' });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
