# Photo2Print 3D Studio - GUI Baslatici
# Kullanim: powershell -File start-studio.ps1   (veya sag tik > PowerShell ile calistir)
# Gereksinim: Node.js (npm) PATH'te kurulu olmali.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$studioUrl = 'http://localhost:5173'
$apiUrl = 'http://localhost:3001'
$logFile = Join-Path $root '.zwork\launcher-dev.log'
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Photo2Print 3D Studio - Baslatici'
$form.Size = New-Object System.Drawing.Size(460, 330)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false

$font = New-Object System.Drawing.Font('Segoe UI', 9)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Foto graf dan 3D Baski Studyo"
$title.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(20, 15)
$title.Size = New-Object System.Drawing.Size(410, 28)
$form.Controls.Add($title)

$status = New-Object System.Windows.Forms.Label
$status.Text = "Durum: Kapali"
$status.Font = $font
$status.ForeColor = [System.Drawing.Color]::Firebrick
$status.Location = New-Object System.Drawing.Point(20, 50)
$status.Size = New-Object System.Drawing.Size(410, 22)
$form.Controls.Add($status)

$netInfo = New-Object System.Windows.Forms.Label
$netInfo.Text = "Yerel ag adresi: -"
$netInfo.Font = $font
$netInfo.Location = New-Object System.Drawing.Point(20, 74)
$netInfo.Size = New-Object System.Drawing.Size(410, 22)
$form.Controls.Add($netInfo)

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = 'Baslat'
$btnStart.Location = New-Object System.Drawing.Point(20, 115)
$btnStart.Size = New-Object System.Drawing.Size(130, 36)
$form.Controls.Add($btnStart)

$btnStop = New-Object System.Windows.Forms.Button
$btnStop.Text = 'Durdur'
$btnStop.Location = New-Object System.Drawing.Point(160, 115)
$btnStop.Size = New-Object System.Drawing.Size(130, 36)
$btnStop.Enabled = $false
$form.Controls.Add($btnStop)

$btnOpen = New-Object System.Windows.Forms.Button
$btnOpen.Text = 'Studoyu Ac'
$btnOpen.Location = New-Object System.Drawing.Point(300, 115)
$btnOpen.Size = New-Object System.Drawing.Size(130, 36)
$btnOpen.Enabled = $false
$form.Controls.Add($btnOpen)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.Font = New-Object System.Drawing.Font('Consolas', 8)
$logBox.Location = New-Object System.Drawing.Point(20, 165)
$logBox.Size = New-Object System.Drawing.Size(410, 130)
$form.Controls.Add($logBox)

$script:devProc = $null

function Log([string]$msg) {
    $stamp = (Get-Date).ToString('HH:mm:ss')
    $logBox.AppendText("[$stamp] $msg`r`n")
}

function Test-Url([string]$url) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Update-Status {
    $webUp = Test-Url $studioUrl
    $apiUp = Test-Url "$apiUrl/api/network-info"
    if ($webUp -and $apiUp) {
        $status.Text = 'Durum: Calisiyor  (Web + API hazir)'
        $status.ForeColor = [System.Drawing.Color]::ForestGreen
        $btnOpen.Enabled = $true
        try {
            $info = (Invoke-WebRequest -Uri "$apiUrl/api/network-info" -UseBasicParsing -TimeoutSec 2).Content | ConvertFrom-Json
            if ($info.lanIp -and $info.frontendPort) {
                $netInfo.Text = "Yerel ag (Wi-Fi) adresi: http://$($info.lanIp):$($info.frontendPort)"
            }
        } catch { }
    } elseif ($webUp -or $apiUp) {
        $status.Text = 'Durum: Kismen calisiyor (bekleniyor...)'
        $status.ForeColor = [System.Drawing.Color]::DarkOrange
        $btnOpen.Enabled = $webUp
    } else {
        if (-not $btnStart.Enabled) {
            $status.Text = 'Durum: Calisiyor ama hazir degil...'
        } else {
            $status.Text = 'Durum: Kapali'
            $status.ForeColor = [System.Drawing.Color]::Firebrick
        }
        $btnOpen.Enabled = $false
        $netInfo.Text = 'Yerel ag adresi: -'
    }
}

$btnStart.Add_Click({
    if ($script:devProc -and -not $script:devProc.HasExited) { return }
    Log 'Sunucu baslatiliyor: npm run dev ...'
    $script:devProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
    $btnStart.Enabled = $false
    $btnStop.Enabled = $true
    $status.Text = 'Durum: Baslatiliyor...'
    $status.ForeColor = [System.Drawing.Color]::DarkOrange
    Log ("PID: " + $script:devProc.Id)
})

$btnStop.Add_Click({
    if ($script:devProc -and -not $script:devProc.HasExited) {
        Log 'Sunucu durduruluyor...'
        Start-Process -FilePath 'taskkill' -ArgumentList '/T', '/F', '/PID', $script:devProc.Id -WindowStyle Hidden -Wait
    }
    $script:devProc = $null
    $btnStart.Enabled = $true
    $btnStop.Enabled = $false
    $btnOpen.Enabled = $false
    $status.Text = 'Durum: Kapali'
    $status.ForeColor = [System.Drawing.Color]::Firebrick
    Log 'Kapandi.'
})

$btnOpen.Add_Click({
    Start-Process $studioUrl
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Update-Status })
$timer.Start()

$form.Add_Shown({ Update-Status })
$form.Add_FormClosed({
    if ($script:devProc -and -not $script:devProc.HasExited) {
        Start-Process -FilePath 'taskkill' -ArgumentList '/T', '/F', '/PID', $script:devProc.Id -WindowStyle Hidden
    }
})

[void]$form.ShowDialog()
