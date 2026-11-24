@echo off
rem Photo2Print 3D Studio - cift tikla baslatici
rem Bu dosya, ayni klasordeki start-studio.ps1 GUI'sini baslatir.
setlocal
cd /d "%~dp0"
if not exist "%~dp0start-studio.ps1" (
  echo start-studio.ps1 bulunamadi. Dosyalari birlikte tutun.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-studio.ps1"
if errorlevel 1 pause
endlocal
