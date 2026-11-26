param(
    [switch]$PortalOnly,
    [switch]$BuildRelease,
    [int]$Port = 3000,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

$LauncherProj = Join-Path $RepoRoot "desktop\3BStudio.Launcher\3BStudio.Launcher.csproj"
$ReleaseExe = Join-Path $RepoRoot "desktop\3BStudio.Launcher\bin\Release\net8.0-windows\3BStudio.Launcher.exe"
$DebugExe = Join-Path $RepoRoot "desktop\3BStudio.Launcher\bin\Debug\net8.0-windows\3BStudio.Launcher.exe"
$TsxCmd = Join-Path $RepoRoot "node_modules\.bin\tsx.cmd"

function Test-ServerReady {
    param([int]$TargetPort)
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$TargetPort/api/network-info" -TimeoutSec 1
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Start-BrowserWhenReady {
    param([int]$TargetPort)
    $cmd = "for(`$i=0;`$i -lt 90;`$i++){try{`$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:$TargetPort/api/network-info' -TimeoutSec 1;if(`$r.StatusCode -eq 200){Start-Process 'http://localhost:$TargetPort';break}}catch{};Start-Sleep -Milliseconds 500}"
    Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", $cmd) -WindowStyle Hidden | Out-Null
}

if (-not (Test-Path $TsxCmd)) {
    Write-Host "[3BStudio] node_modules\.bin\tsx.cmd eksik; npm install calistiriliyor..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw "npm install basarisiz oldu (cikis kodu: $LASTEXITCODE)."
    }
    if (-not (Test-Path $TsxCmd)) {
        throw "npm install tamamlandi ancak node_modules\.bin\tsx.cmd bulunamadi."
    }
}

if ($BuildRelease) {
    Write-Host "[3BStudio] WPF Masaustu GUI (Release) derleniyor..." -ForegroundColor Cyan
    dotnet build $LauncherProj -c Release
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet build -c Release basarisiz oldu (cikis kodu: $LASTEXITCODE)."
    }
    Write-Host "[3BStudio] Hazir: $ReleaseExe" -ForegroundColor Green
    exit 0
}

if ($PortalOnly) {
    if (Test-ServerReady -TargetPort $Port) {
        Write-Host "[3BStudio] Port $Port uzerinde calisan sunucu algilandi: http://localhost:$Port" -ForegroundColor Green
        if (-not $NoBrowser) {
            Start-Process "http://localhost:$Port" | Out-Null
        }
        exit 0
    }
    $env:PORT = "$Port"
    $env:HOST = "0.0.0.0"
    Write-Host "[3BStudio] Yerel Web Portali baslatiliyor: http://localhost:$Port" -ForegroundColor Cyan
    if (-not $NoBrowser) {
        Start-BrowserWhenReady -TargetPort $Port
    }
    npm run dev
    exit $LASTEXITCODE
}

$env:PORT = "$Port"
$LauncherArgs = @("--port=$Port")
if ($NoBrowser) {
    $LauncherArgs += "--no-browser"
}

if (Test-Path $ReleaseExe) {
    Start-Process $ReleaseExe -ArgumentList $LauncherArgs -WorkingDirectory $RepoRoot
    exit 0
}

if (Test-Path $DebugExe) {
    Start-Process $DebugExe -ArgumentList $LauncherArgs -WorkingDirectory $RepoRoot
    exit 0
}

if (Get-Command dotnet -ErrorAction SilentlyContinue) {
    Write-Host "[3BStudio] WPF Masaustu GUI Baslaticisi aciliyor..." -ForegroundColor Cyan
    dotnet run --project $LauncherProj -- @LauncherArgs
    exit $LASTEXITCODE
} else {
    Write-Host "[UYARI] .NET 8 SDK bulunamadi. Web Portali tarayicida aciliyor..." -ForegroundColor Yellow
    Write-Host "WPF Masaustu GUI kurmak icin: winget install Microsoft.DotNet.SDK.8" -ForegroundColor Gray
    if (Test-ServerReady -TargetPort $Port) {
        Write-Host "[3BStudio] Port $Port uzerinde calisan sunucu algilandi: http://localhost:$Port" -ForegroundColor Green
        if (-not $NoBrowser) {
            Start-Process "http://localhost:$Port" | Out-Null
        }
        exit 0
    }
    $env:PORT = "$Port"
    $env:HOST = "0.0.0.0"
    if (-not $NoBrowser) {
        Start-BrowserWhenReady -TargetPort $Port
    }
    npm run dev
    exit $LASTEXITCODE
}
