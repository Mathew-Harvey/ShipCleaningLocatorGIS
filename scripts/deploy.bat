@echo off
echo === Ship Cleaning GIS Deployment Script ===
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed. Please install Node.js 14+ first.
    exit /b 1
)

REM Get Node version
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo Node.js version: %NODE_VERSION%

REM Install dependencies
echo.
echo Installing dependencies...
call npm install --production

REM Create necessary directories
echo.
echo Creating data directories...
if not exist "gis_data" mkdir gis_data
if not exist "fallback_data" mkdir fallback_data
if not exist "calculated_zones" mkdir calculated_zones
if not exist "zone_cache" mkdir zone_cache
if not exist "public\css" mkdir public\css

REM Initialize data
echo.
echo Initializing GIS data...
echo This may take several minutes depending on your internet connection...
call npm run init-data

REM Check if PM2 is installed
where pm2 >nul 2>nul
if %errorlevel% equ 0 (
    echo.
    echo PM2 is installed. Setting up process management...
    
    REM Stop existing process if running
    call pm2 stop ship-cleaning-gis 2>nul
    
    REM Start the application
    call pm2 start server.js --name ship-cleaning-gis
    call pm2 save
    
    echo Application started with PM2
    echo   - To view logs: pm2 logs ship-cleaning-gis
    echo   - To monitor: pm2 monit
    echo   - To stop: pm2 stop ship-cleaning-gis
) else (
    echo.
    echo PM2 is not installed. Starting application directly...
    echo For production deployment, consider installing PM2:
    echo   npm install -g pm2
    echo.
    echo Starting server...
    node server.js
)

echo.
echo === Deployment Complete ===
echo The application should now be running at http://localhost:3000
echo.
echo Next steps:
echo 1. Configure your firewall to allow port 3000 or set up a reverse proxy
echo 2. Set up SSL/TLS certificates if exposing to the internet
echo 3. Configure automatic startup with 'pm2 startup' if using PM2 