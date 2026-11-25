# 3BStudio - WPF Baslatici (yuvarlatilmis baslik cubugu + tema)
# Kullanim: powershell -ExecutionPolicy Bypass -File start-studio.ps1
# Gereksinim: Node.js (npm) PATH'te; .NET/WPF Windows ile birlikte gelir.

$ErrorActionPreference = 'Stop'
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Current server.ts serves both the UI and API on PORT (3000 by default).
$studioUrl = 'http://localhost:3000'
$apiUrl = $studioUrl
$logFile = Join-Path $rootDir '.zwork\launcher-dev.log'
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="3BStudio" Height="400" Width="500"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" WindowStartupLocation="CenterScreen"
        FontFamily="Segoe UI">
  <Border x:Name="Root" CornerRadius="18" BorderThickness="1" BorderBrush="#1E2A44" Background="#0B1220">
    <Border.Effect>
      <DropShadowEffect BlurRadius="26" ShadowDepth="7" Opacity="0.45" Color="#000000"/>
    </Border.Effect>
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="48"/>
        <RowDefinition Height="*"/>
      </Grid.RowDefinitions>

      <Border x:Name="TitleBar" Grid.Row="0" CornerRadius="18,18,0,0" Background="#0F1A2E">
        <Grid Margin="14,0,8,0">
          <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
            <Border Width="26" Height="26" CornerRadius="9" Background="#22D3EE">
              <TextBlock Text="3B" Foreground="#04121F" FontSize="12" FontWeight="Bold"
                         HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <TextBlock x:Name="AppTitle" Text="3BStudio" Margin="10,0,0,0" FontSize="14"
                       FontWeight="SemiBold" VerticalAlignment="Center" Foreground="#E2E8F0"/>
            <TextBlock x:Name="AppSubtitle" Text="fotograftan 3D baski" Margin="8,1,0,0" FontSize="10"
                       VerticalAlignment="Center" Foreground="#64748B"/>
          </StackPanel>
          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
            <Border x:Name="ThemeBtn" Width="34" Height="28" CornerRadius="9" Background="#16233B" Cursor="Hand">
              <TextBlock x:Name="ThemeGlyph" Text="&#x2600;" FontSize="12" Foreground="#E2E8F0"
                         HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <Border x:Name="MinBtn" Width="34" Height="28" CornerRadius="9" Background="Transparent" Cursor="Hand" Margin="4,0,0,0">
              <TextBlock Text="&#x2013;" FontSize="14" Foreground="#94A3B8"
                         HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <Border x:Name="CloseBtn" Width="34" Height="28" CornerRadius="9" Background="Transparent" Cursor="Hand" Margin="2,0,0,0">
              <TextBlock Text="&#x2715;" FontSize="12" Foreground="#94A3B8"
                         HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
          </StackPanel>
        </Grid>
      </Border>

      <StackPanel Grid.Row="1" Margin="18,12,18,16">
        <StackPanel Orientation="Horizontal">
          <Ellipse x:Name="StatusDot" Width="10" Height="10" Fill="#EF4444" VerticalAlignment="Center"/>
          <TextBlock x:Name="StatusText" Text="Durum: Kapali" Margin="8,0,0,0" FontSize="12"
                     FontWeight="SemiBold" Foreground="#F87171" VerticalAlignment="Center"/>
        </StackPanel>
        <TextBlock x:Name="LanText" Text="Yerel ag adresi: -" Margin="0,6,0,0" FontSize="11" Foreground="#94A3B8"/>

        <UniformGrid Rows="1" Columns="3" Margin="0,14,0,0">
          <Border x:Name="BtnStart" CornerRadius="12" Background="#22D3EE" Cursor="Hand" Height="40" Margin="0,0,5,0">
            <TextBlock x:Name="BtnStartText" Text="Baslat" FontSize="12" FontWeight="Bold"
                       Foreground="#04121F" HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <Border x:Name="BtnStop" CornerRadius="12" Background="#1B2B47" Cursor="Hand" Height="40" Margin="5,0,5,0" Opacity="0.5">
            <TextBlock x:Name="BtnStopText" Text="Durdur" FontSize="12" FontWeight="SemiBold"
                       Foreground="#94A3B8" HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <Border x:Name="BtnOpen" CornerRadius="12" Background="#1B2B47" Cursor="Hand" Height="40" Margin="5,0,0,0" Opacity="0.5">
            <TextBlock x:Name="BtnOpenText" Text="Studyoyu Ac" FontSize="12" FontWeight="SemiBold"
                       Foreground="#94A3B8" HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
        </UniformGrid>

        <TextBlock x:Name="HintText" Margin="2,10,0,8" FontSize="10" Foreground="#64748B" TextWrapping="Wrap"
                   Text="Ilk deneme: Studyoyu Ac > Ornek Parts > Kirik L-Braket > Yerel 3D Model Olustur."/>

        <Border x:Name="LogPanel" CornerRadius="12" Background="#070D18" BorderThickness="1" BorderBrush="#16233B">
          <TextBox x:Name="LogBox" Margin="10,8" Height="150" Background="Transparent" BorderThickness="0"
                   Foreground="#A7F3D0" FontFamily="Consolas" FontSize="11" IsReadOnly="True"
                   VerticalScrollBarVisibility="Auto" TextWrapping="Wrap" AcceptsReturn="True"/>
        </Border>
      </StackPanel>
    </Grid>
  </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)

function Find([string]$name) { $window.FindName($name) }

$root = Find 'Root'
$titleBar = Find 'TitleBar'
$appTitle = Find 'AppTitle'
$appSubtitle = Find 'AppSubtitle'
$themeBtn = Find 'ThemeBtn'
$themeGlyph = Find 'ThemeGlyph'
$minBtn = Find 'MinBtn'
$closeBtn = Find 'CloseBtn'
$statusDot = Find 'StatusDot'
$statusText = Find 'StatusText'
$lanText = Find 'LanText'
$btnStart = Find 'BtnStart'
$btnStartText = Find 'BtnStartText'
$btnStop = Find 'BtnStop'
$btnStopText = Find 'BtnStopText'
$btnOpen = Find 'BtnOpen'
$btnOpenText = Find 'BtnOpenText'
$hintText = Find 'HintText'
$logPanel = Find 'LogPanel'
$logBox = Find 'LogBox'

$script:theme = 'dark'
$script:devProc = $null
$script:running = $false

$palettes = @{
    dark = @{
        Root = '#0B1220'; RootBorder = '#1E2A44'; TitleBar = '#0F1A2E'
        Text = '#E2E8F0'; Sub = '#64748B'; Muted = '#94A3B8'
        Accent = '#22D3EE'; AccentText = '#04121F'; Button = '#1B2B47'
        LogPanel = '#070D18'; LogBorder = '#16233B'; LogText = '#A7F3D0'; Glyph = [char]0x2600
    }
    light = @{
        Root = '#F8FAFC'; RootBorder = '#CBD5E1'; TitleBar = '#FFFFFF'
        Text = '#0F172A'; Sub = '#64748B'; Muted = '#475569'
        Accent = '#0891B2'; AccentText = '#FFFFFF'; Button = '#E2E8F0'
        LogPanel = '#F1F5F9'; LogBorder = '#E2E8F0'; LogText = '#0F172A'; Glyph = [char]0x263E
    }
}

function Brush([string]$hex) {
    [Windows.Media.BrushConverter]::new().ConvertFromString($hex)
}

function Apply-Theme([string]$name) {
    $p = $palettes[$name]
    $script:theme = $name
    $root.Background = Brush $p.Root
    $root.BorderBrush = Brush $p.RootBorder
    $titleBar.Background = Brush $p.TitleBar
    $appTitle.Foreground = Brush $p.Text
    $appSubtitle.Foreground = Brush $p.Sub
    $themeGlyph.Text = [string]$p.Glyph
    $themeGlyph.Foreground = Brush $p.Text
    $themeBtn.Background = Brush $p.Button
    $statusText.Foreground = if ($script:running) { Brush '#22C55E' } else { Brush '#EF4444' }
    $lanText.Foreground = Brush $p.Muted
    $hintText.Foreground = Brush $p.Sub
    $logPanel.Background = Brush $p.LogPanel
    $logPanel.BorderBrush = Brush $p.LogBorder
    $logBox.Foreground = Brush $p.LogText
    foreach ($pair in @(
        @($btnStop, $btnStopText), @($btnOpen, $btnOpenText)
    )) {
        $pair[0].Background = Brush $p.Button
        if (-not $script:running) { $pair[1].Foreground = Brush $p.Muted }
    }
    if (-not $script:running) {
        $btnStart.Background = Brush $p.Button
        $btnStartText.Foreground = Brush $p.Muted
    } else {
        $btnStart.Background = Brush $p.Accent
        $btnStartText.Foreground = Brush $p.AccentText
        $btnStopText.Foreground = Brush $p.Text
        $btnOpenText.Foreground = Brush $p.Text
    }
}

function Write-Log([string]$message) {
    $stamp = (Get-Date).ToString('HH:mm:ss')
    $logBox.AppendText("[$stamp] $message`r`n")
    $logBox.ScrollToEnd()
}

function Set-Running([bool]$value) {
    if ($script:running -eq $value) {
        Apply-Theme $script:theme
        return
    }
    $script:running = $value
    $btnStart.Opacity = if ($value) { 0.45 } else { 1 }
    $btnStop.Opacity = if ($value) { 1 } else { 0.45 }
    $btnOpen.Opacity = if ($value) { 1 } else { 0.45 }
    Apply-Theme $script:theme
}

function Update-Ui {
    # One short health request keeps the dispatcher responsive. The old
    # launcher checked obsolete ports 5173 and 3001 with three synchronous
    # requests per tick, freezing the WPF window for several seconds.
    $info = $null
    try {
        $response = Invoke-WebRequest -Uri "$apiUrl/api/network-info" -UseBasicParsing -TimeoutSec 1
        if ($response.StatusCode -eq 200) { $info = $response.Content | ConvertFrom-Json }
    } catch { }

    if ($info) {
        Set-Running $true
        $statusText.Text = 'Durum: Calisiyor  (Yerel sunucu hazir)'
        $statusText.Foreground = Brush '#22C55E'
        $statusDot.Fill = Brush '#22C55E'
        $lanText.Text = "Yerel ag (Wi-Fi): http://$($info.lanIp):$($info.frontendPort)"
        return
    }

    if ($script:devProc -and -not $script:devProc.HasExited) {
        Set-Running $true
        $statusText.Text = 'Durum: Baslatiliyor...'
        $statusText.Foreground = Brush '#F59E0B'
        $statusDot.Fill = Brush '#F59E0B'
        return
    }

    Set-Running $false
    $statusText.Text = 'Durum: Kapali'
    $statusText.Foreground = Brush '#EF4444'
    $statusDot.Fill = Brush '#EF4444'
    $lanText.Text = 'Yerel ag adresi: -'
}

# --- Baslik cubugu: surukleme ve dugmeler ---
$titleBar.Add_MouseLeftButtonDown({
    param($sender, $event)
    $src = $event.OriginalSource
    if ($src -eq $titleBar -or $src -eq $appTitle -or $src -eq $appSubtitle) {
        $window.DragMove()
    }
})

$minBtn.Add_MouseLeftButtonUp({ $window.WindowState = 'Minimized' })
$closeBtn.Add_MouseLeftButtonUp({ $window.Close() })
$themeBtn.Add_MouseLeftButtonUp({
    $next = if ($script:theme -eq 'dark') { 'light' } else { 'dark' }
    Apply-Theme $next
    Write-Log "Tema: $next"
})

$btnOpen.Add_MouseLeftButtonUp({
    if ($script:running) { Start-Process $studioUrl }
})

$btnStart.Add_MouseLeftButtonUp({
    if ($script:devProc -and -not $script:devProc.HasExited) { return }
    Write-Log 'Sunucu baslatiliyor: npm run dev ...'
    try {
        $script:devProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' `
            -WorkingDirectory $rootDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
        Write-Log "PID: $($script:devProc.Id)"
        Set-Running $true
        $statusText.Text = 'Durum: Baslatiliyor...'
        $statusText.Foreground = Brush '#F59E0B'
        $statusDot.Fill = Brush '#F59E0B'
    } catch {
        Write-Log "Baslatma hatasi: $($_.Exception.Message)"
    }
})

$btnStop.Add_MouseLeftButtonUp({
    if ($script:devProc -and -not $script:devProc.HasExited) {
        Write-Log 'Sunucu durduruluyor...'
        Start-Process -FilePath 'taskkill' -ArgumentList '/T', '/F', '/PID', $script:devProc.Id -WindowStyle Hidden -Wait
    }
    $script:devProc = $null
    Set-Running $false
    $statusText.Text = 'Durum: Kapali'
    $statusText.Foreground = Brush '#EF4444'
    $statusDot.Fill = Brush '#EF4444'
    Write-Log 'Kapandi.'
})

$window.Add_Closed({
    if ($script:devProc -and -not $script:devProc.HasExited) {
        Start-Process -FilePath 'taskkill' -ArgumentList '/T', '/F', '/PID', $script:devProc.Id -WindowStyle Hidden
    }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)
$timer.Add_Tick({ Update-Ui })
$timer.Start()

Apply-Theme 'dark'
$window.Add_Loaded({ Update-Ui })
Write-Log '3BStudio baslatici hazir.'
[void]$window.ShowDialog()
