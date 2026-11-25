param(
    [switch]$PortalOnly,
    [switch]$BuildRelease,
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

$LauncherProj = Join-Path $RepoRoot "desktop\3BStudio.Launcher\3BStudio.Launcher.csproj"
$ReleaseExe = Join-Path $RepoRoot "desktop\3BStudio.Launcher\bin\Release\net8.0-windows\3BStudio.Launcher.exe"

if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
    Write-Host "[3BStudio] node_modules eksik; npm install calistiriliyor..." -ForegroundColor Cyan
    npm install
}

if ($BuildRelease) {
    Write-Host "[3BStudio] WPF Masaustu GUI (Release) derleniyor..." -ForegroundColor Cyan
    dotnet build $LauncherProj -c Release
    Write-Host "[3BStudio] Hazir: $ReleaseExe" -ForegroundColor Green
    exit 0
}

if ($PortalOnly) {
    $env:PORT = "$Port"
    Write-Host "[3BStudio] Yerel Web Portali baslatiliyor: http://localhost:$Port" -ForegroundColor Cyan
    Start-Process "http://localhost:$Port"
    npm run dev
    exit 0
}

if (Test-Path $ReleaseExe) {
    Start-Process $ReleaseExe
    exit 0
}

if (Get-Command dotnet -ErrorAction SilentlyContinue) {
    Write-Host "[3BStudio] WPF Masaustu GUI Baslaticisi aciliyor..." -ForegroundColor Cyan
    dotnet run --project $LauncherProj
} else {
    Write-Host "[UYARI] .NET 8 SDK bulunamadi. Web Portali tarayicida aciliyor..." -ForegroundColor Yellow
    Write-Host "WPF Masaustu GUI kurmak icin: winget install Microsoft.DotNet.SDK.8" -ForegroundColor Gray
    $env:PORT = "$Port"
    Start-Process "http://localhost:$Port"
    npm run dev
}
