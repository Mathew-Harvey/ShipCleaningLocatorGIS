#!/bin/bash

# Ship Cleaning GIS Deployment Script

echo "=== Ship Cleaning GIS Deployment Script ==="
echo

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 14+ first."
    exit 1
fi

NODE_VERSION=$(node -v)
echo "✓ Node.js version: $NODE_VERSION"

# Install dependencies
echo
echo "Installing dependencies..."
npm install --production

# Create necessary directories
echo
echo "Creating data directories..."
mkdir -p gis_data
mkdir -p fallback_data
mkdir -p calculated_zones
mkdir -p zone_cache
mkdir -p public/css

# Initialize data
echo
echo "Initializing GIS data..."
echo "This may take several minutes depending on your internet connection..."
npm run init-data

# Check if PM2 is installed
if command -v pm2 &> /dev/null; then
    echo
    echo "PM2 is installed. Setting up process management..."
    
    # Stop existing process if running
    pm2 stop ship-cleaning-gis 2>/dev/null || true
    
    # Start the application
    pm2 start server.js --name ship-cleaning-gis
    pm2 save
    
    echo "✓ Application started with PM2"
    echo "  - To view logs: pm2 logs ship-cleaning-gis"
    echo "  - To monitor: pm2 monit"
    echo "  - To stop: pm2 stop ship-cleaning-gis"
else
    echo
    echo "PM2 is not installed. Starting application directly..."
    echo "For production deployment, consider installing PM2:"
    echo "  npm install -g pm2"
    echo
    echo "Starting server..."
    node server.js
fi

echo
echo "=== Deployment Complete ==="
echo "The application should now be running at http://localhost:3000"
echo
echo "Next steps:"
echo "1. Configure your firewall to allow port 3000 (or set up a reverse proxy)"
echo "2. Set up SSL/TLS certificates if exposing to the internet"
echo "3. Configure automatic startup with 'pm2 startup' if using PM2" 