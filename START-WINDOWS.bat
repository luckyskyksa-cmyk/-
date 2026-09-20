@echo off
cd /d "%~dp0"
title Lucky Sky

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is NOT installed.
  echo Please install it from https://nodejs.org  ^(green LTS button^)
  echo Then run this file again.
  echo.
  pause
  exit /b
)

if not exist node_modules (
  echo Preparing the app for the first time... please wait 1-2 minutes.
  call npm install
  if errorlevel 1 (
    echo.
    echo Setup failed. Check your internet connection and try again.
    pause
    exit /b
  )
)

echo.
echo ============================================
echo   Lucky Sky is running.
echo   Open your browser at:  http://localhost:3000
echo   Password:  luckysky
echo   Keep this window open while using the app.
echo ============================================
echo.
start "" http://localhost:3000
call npm start
pause
