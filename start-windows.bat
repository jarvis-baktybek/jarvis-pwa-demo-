@echo off
cd /d "%~dp0"
node --version
if errorlevel 1 (
  echo Install Node.js 20+ first.
  pause
  exit /b 1
)
node server.js
pause
