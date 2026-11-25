@echo off
setlocal
title 3BStudio Yerel Baslatici
cd /d "%~dp0"

set "EXE_RELEASE=%~dp0desktop\3BStudio.Launcher\bin\Release\net8.0-windows\3BStudio.Launcher.exe"
set "EXE_DEBUG=%~dp0desktop\3BStudio.Launcher\bin\Debug\net8.0-windows\3BStudio.Launcher.exe"

if exist "%EXE_RELEASE%" (
    start "" "%EXE_RELEASE%"
    exit /b 0
)

if exist "%EXE_DEBUG%" (
    start "" "%EXE_DEBUG%"
    exit /b 0
)

where dotnet >nul 2>nul
if %errorlevel%==0 (
    echo [3BStudio] WPF Masaustu GUI Baslaticisi derlenip aciliyor...
    dotnet run --project "%~dp0desktop\3BStudio.Launcher\3BStudio.Launcher.csproj"
    exit /b %errorlevel%
)

echo.
echo [3BStudio] .NET 8 SDK bulunamadi; dogrudan Yerel Web Portali baslatiliyor...
echo [Ipucu] Masaustu WPF GUI icin kurulum: winget install Microsoft.DotNet.SDK.8
echo.

if not exist "%~dp0node_modules" (
    echo [3BStudio] Bagimliliklar kuruluyor ^(npm install^)...
    call npm install
)

start "" "http://localhost:3000"
call npm run dev
endlocal
