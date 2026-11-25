@echo off
rem 3BStudio - çift tıkla yerel başlatıcı
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-studio.ps1"
if errorlevel 1 pause
endlocal
