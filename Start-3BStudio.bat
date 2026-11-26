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

if not exist "%~dp0node_modules\.bin\tsx.cmd" (
    echo [3BStudio] Bagimliliklar kuruluyor ^(npm install^)...
    call npm install
    if errorlevel 1 (
        echo [HATA] npm install basarisiz oldu.
        exit /b 1
    )
    if not exist "%~dp0node_modules\.bin\tsx.cmd" (
        echo [HATA] node_modules\.bin\tsx.cmd bulunamadi.
        exit /b 1
    )
)

if not defined PORT set "PORT=3000"
if not defined HOST set "HOST=0.0.0.0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "try{$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/api/network-info' -TimeoutSec 1;if($r.StatusCode -eq 200){exit 0}}catch{};exit 1"
if %errorlevel%==0 (
    echo [3BStudio] Port %PORT% uzerinde calisan sunucu algilandi: http://localhost:%PORT%
    start "" "http://localhost:%PORT%"
    exit /b 0
)

echo [3BStudio] Sunucu hazir olunca tarayici acilacak: http://localhost:%PORT%
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "for($i=0;$i -lt 90;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/api/network-info' -TimeoutSec 1;if($r.StatusCode -eq 200){Start-Process 'http://localhost:%PORT%';break}}catch{};Start-Sleep -Milliseconds 500}"
call npm run dev
exit /b %errorlevel%
endlocal
