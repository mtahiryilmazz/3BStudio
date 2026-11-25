param([int]$Port = 3000)

# 3BStudio local launcher. It is intentionally self-contained: Windows PowerShell + WPF only.
$ErrorActionPreference = 'Stop'
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$studioUrl = "http://localhost:$Port"
$apiUrl = "http://127.0.0.1:$Port"

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Net.Http

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="3BStudio Başlatıcı" Height="590" Width="680" MinHeight="540" MinWidth="600"
        WindowStartupLocation="CenterScreen" WindowStyle="None" ResizeMode="CanResizeWithGrip"
        AllowsTransparency="True" Background="Transparent" FontFamily="Segoe UI">
  <Window.Resources>
    <SolidColorBrush x:Key="Canvas" Color="#09111E" />
    <SolidColorBrush x:Key="Surface" Color="#101C2D" />
    <SolidColorBrush x:Key="SurfaceRaised" Color="#15243A" />
    <SolidColorBrush x:Key="Line" Color="#263A52" />
    <SolidColorBrush x:Key="TextMain" Color="#F1F5F9" />
    <SolidColorBrush x:Key="TextMuted" Color="#9BAFC5" />
    <SolidColorBrush x:Key="Teal" Color="#2DD4BF" />
    <SolidColorBrush x:Key="TealDark" Color="#0F766E" />
    <Style x:Key="ActionButton" TargetType="Button">
      <Setter Property="Foreground" Value="#E8F0F7" />
      <Setter Property="Background" Value="{StaticResource SurfaceRaised}" />
      <Setter Property="BorderBrush" Value="{StaticResource Line}" />
      <Setter Property="BorderThickness" Value="1" />
      <Setter Property="Padding" Value="14,11" />
      <Setter Property="FontSize" Value="12" />
      <Setter Property="FontWeight" Value="SemiBold" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="Focusable" Value="True" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="ButtonBorder" Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}"
                    CornerRadius="10" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" />
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="ButtonBorder" Property="BorderBrush" Value="{StaticResource Teal}" /><Setter TargetName="ButtonBorder" Property="Background" Value="#1A2C42" /></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="ButtonBorder" Property="Opacity" Value="0.78" /></Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="ButtonBorder" Property="BorderBrush" Value="{StaticResource Teal}" /></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="ButtonBorder" Property="Opacity" Value="0.42" /></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="PrimaryButton" TargetType="Button" BasedOn="{StaticResource ActionButton}">
      <Setter Property="Foreground" Value="#04201E" />
      <Setter Property="Background" Value="{StaticResource Teal}" />
      <Setter Property="BorderBrush" Value="{StaticResource Teal}" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="ButtonBorder" Background="{TemplateBinding Background}" CornerRadius="10" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" />
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="ButtonBorder" Property="Background" Value="#5EEAD4" /></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="ButtonBorder" Property="Opacity" Value="0.78" /></Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="ButtonBorder" Property="BorderBrush" Value="White" /></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="ButtonBorder" Property="Opacity" Value="0.42" /></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Border x:Name="Root" Background="{StaticResource Canvas}" BorderBrush="{StaticResource Line}"
          BorderThickness="1" CornerRadius="18">
    <Grid>
      <Grid.RowDefinitions><RowDefinition Height="64" /><RowDefinition Height="*" /></Grid.RowDefinitions>
      <Border x:Name="TitleBar" Grid.Row="0" Background="#0D1929" CornerRadius="18,18,0,0" BorderBrush="{StaticResource Line}" BorderThickness="0,0,0,1">
        <Grid Margin="18,0,10,0">
          <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
          <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center">
            <Border Width="34" Height="34" CornerRadius="10" Background="{StaticResource Teal}" Margin="0,0,11,0">
              <TextBlock Text="3B" Foreground="#04201E" FontWeight="Bold" FontSize="13" HorizontalAlignment="Center" VerticalAlignment="Center" />
            </Border>
            <StackPanel VerticalAlignment="Center">
              <TextBlock x:Name="AppTitle" Text="3BStudio" Foreground="{StaticResource TextMain}" FontWeight="Bold" FontSize="15" />
              <TextBlock x:Name="AppSubtitle" Text="Yerel modelleme stüdyosu" Foreground="{StaticResource TextMuted}" FontSize="10.5" Margin="0,2,0,0" />
            </StackPanel>
          </StackPanel>
          <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center">
            <Button x:Name="MinBtn" Content="—" Width="34" Height="30" Padding="0" Style="{StaticResource ActionButton}" Margin="0,0,6,0" />
            <Button x:Name="CloseBtn" Content="×" Width="34" Height="30" Padding="0" Style="{StaticResource ActionButton}" />
          </StackPanel>
        </Grid>
      </Border>

      <Grid Grid.Row="1" Margin="22,20,22,18">
        <Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /><RowDefinition Height="*" /><RowDefinition Height="Auto" /></Grid.RowDefinitions>
        <Border Grid.Row="0" Background="{StaticResource Surface}" BorderBrush="{StaticResource Line}" BorderThickness="1" CornerRadius="14" Padding="17" Margin="0,0,0,14">
          <Grid>
            <Grid.ColumnDefinitions><ColumnDefinition Width="Auto" /><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
            <Ellipse x:Name="StatusDot" Grid.Column="0" Width="11" Height="11" Fill="#64748B" VerticalAlignment="Top" Margin="1,5,12,0" />
            <StackPanel Grid.Column="1">
              <TextBlock x:Name="StatusText" Text="Yerel sunucu denetleniyor…" Foreground="{StaticResource TextMain}" FontSize="14" FontWeight="SemiBold" />
              <TextBlock x:Name="StatusDetail" Text="Başlatıcı hazır olduğunda bu pencere yanıt vermeye devam eder." Foreground="{StaticResource TextMuted}" FontSize="11" TextWrapping="Wrap" Margin="0,4,0,0" />
            </StackPanel>
            <Border Grid.Column="2" Background="#0A302E" CornerRadius="7" Padding="9,5" VerticalAlignment="Top">
              <TextBlock Text="ÇEVRİMDIŞI HAZIR" Foreground="{StaticResource Teal}" FontSize="9" FontWeight="Bold" />
            </Border>
          </Grid>
        </Border>

        <Grid Grid.Row="1" Margin="0,0,0,14">
          <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="Auto" /></Grid.ColumnDefinitions>
          <StackPanel Grid.Column="0" VerticalAlignment="Center">
            <TextBlock Text="Yerel ağ adresi" Foreground="{StaticResource TextMuted}" FontSize="10" />
            <TextBlock x:Name="LanText" Text="Sunucu başlatılınca gösterilecek" Foreground="{StaticResource TextMain}" FontFamily="Consolas" FontSize="11" Margin="0,4,0,0" TextTrimming="CharacterEllipsis" />
          </StackPanel>
          <Button x:Name="BtnCopy" Grid.Column="1" Content="Adresi Kopyala" Style="{StaticResource ActionButton}" Padding="11,8" />
        </Grid>

        <Border Grid.Row="2" Background="#070D16" BorderBrush="{StaticResource Line}" BorderThickness="1" CornerRadius="13" Padding="13" MinHeight="160">
          <Grid>
            <Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="*" /></Grid.RowDefinitions>
            <DockPanel Grid.Row="0" Margin="0,0,0,9">
              <StackPanel DockPanel.Dock="Left" Orientation="Horizontal" VerticalAlignment="Center">
                <Ellipse Width="6" Height="6" Fill="{StaticResource Teal}" Margin="0,0,7,0" />
                <TextBlock Text="SUNUCU GÜNLÜĞÜ" Foreground="#AFC0D2" FontWeight="Bold" FontSize="9.5" VerticalAlignment="Center" />
              </StackPanel>
              <Button x:Name="BtnClear" DockPanel.Dock="Right" Content="Temizle" Style="{StaticResource ActionButton}" Padding="9,4" FontSize="10" />
            </DockPanel>
            <TextBox x:Name="LogBox" Grid.Row="1" Background="Transparent" BorderThickness="0" Foreground="#B8E9D8"
                     FontFamily="Consolas" FontSize="10.5" IsReadOnly="True" AcceptsReturn="True" TextWrapping="Wrap"
                     VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" />
          </Grid>
        </Border>

        <Grid Grid.Row="3" Margin="0,14,0,0">
          <Grid.RowDefinitions><RowDefinition Height="Auto" /><RowDefinition Height="Auto" /></Grid.RowDefinitions>
          <Grid Grid.Row="0">
            <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="10" /><ColumnDefinition Width="*" /><ColumnDefinition Width="10" /><ColumnDefinition Width="*" /></Grid.ColumnDefinitions>
            <Button x:Name="BtnStart" Grid.Column="0" Content="Sunucuyu Başlat" Style="{StaticResource PrimaryButton}" />
            <Button x:Name="BtnStop" Grid.Column="2" Content="Sunucuyu Durdur" Style="{StaticResource ActionButton}" IsEnabled="False" />
            <Button x:Name="BtnOpen" Grid.Column="4" Content="Web Portalını Aç" Style="{StaticResource ActionButton}" IsEnabled="False" />
          </Grid>
          <StackPanel Grid.Row="1" Orientation="Horizontal" HorizontalAlignment="Center" Margin="0,12,0,0">
            <TextBlock Text="İnternet gerekmez" Foreground="{StaticResource TextMuted}" FontSize="10" />
            <TextBlock Text="  ·  " Foreground="#52647A" FontSize="10" />
            <TextBlock Text="Pixal3D / ComfyUI yerel kurulumla kullanılabilir" Foreground="{StaticResource TextMuted}" FontSize="10" />
          </StackPanel>
        </Grid>
      </Grid>
    </Grid>
  </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
function Find([string]$name) { $window.FindName($name) }

$root = Find 'Root'
$titleBar = Find 'TitleBar'
$statusDot = Find 'StatusDot'
$statusText = Find 'StatusText'
$statusDetail = Find 'StatusDetail'
$lanText = Find 'LanText'
$btnStart = Find 'BtnStart'
$btnStop = Find 'BtnStop'
$btnOpen = Find 'BtnOpen'
$btnCopy = Find 'BtnCopy'
$btnClear = Find 'BtnClear'
$logBox = Find 'LogBox'

$script:process = $null
$script:ownsProcess = $false
$script:ready = $false
$script:lanUrl = $null
$script:healthTask = $null
$script:nextHealthCheck = [DateTime]::UtcNow
$script:lastProcessExit = $null
$script:logQueue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$script:httpClient = [System.Net.Http.HttpClient]::new()
$script:httpClient.Timeout = [TimeSpan]::FromSeconds(3)

function Write-Log([string]$message) {
    if ([string]::IsNullOrWhiteSpace($message)) { return }
    $stamp = (Get-Date).ToString('HH:mm:ss')
    $logBox.AppendText("[$stamp] $message`r`n")
    if ($logBox.Text.Length -gt 30000) { $logBox.Text = $logBox.Text.Substring($logBox.Text.Length - 22000) }
    $logBox.ScrollToEnd()
}

function Set-State([string]$kind, [string]$title, [string]$detail) {
    $statusText.Text = $title
    $statusDetail.Text = $detail
    switch ($kind) {
        'ready' { $statusDot.Fill = [Windows.Media.BrushConverter]::new().ConvertFromString('#2DD4BF') }
        'starting' { $statusDot.Fill = [Windows.Media.BrushConverter]::new().ConvertFromString('#FBBF24') }
        'error' { $statusDot.Fill = [Windows.Media.BrushConverter]::new().ConvertFromString('#FB7185') }
        default { $statusDot.Fill = [Windows.Media.BrushConverter]::new().ConvertFromString('#64748B') }
    }
}

function Start-HealthCheck {
    if ($script:healthTask -or [DateTime]::UtcNow -lt $script:nextHealthCheck) { return }
    $script:nextHealthCheck = [DateTime]::UtcNow.AddSeconds(2)
    try { $script:healthTask = $script:httpClient.GetAsync("$apiUrl/api/network-info") }
    catch { $script:healthTask = $null }
}

function Complete-HealthCheck {
    if (-not $script:healthTask -or -not $script:healthTask.IsCompleted) { return }
    $response = $null
    try {
        $response = $script:healthTask.GetAwaiter().GetResult()
        if ($response.IsSuccessStatusCode) {
            $json = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $info = $json | ConvertFrom-Json
            $script:ready = $true
            $script:lanUrl = if ($info.lanIp -and $info.frontendPort) { "http://$($info.lanIp):$($info.frontendPort)" } else { $studioUrl }
            $lanText.Text = $script:lanUrl
            $btnStart.IsEnabled = $false
            $btnStop.IsEnabled = $script:ownsProcess
            $btnOpen.IsEnabled = $true
            if ($script:ownsProcess) {
                Set-State 'ready' '3BStudio hazır' "Yerel stüdyo $studioUrl adresinde çalışıyor."
            } else {
                Set-State 'ready' '3BStudio zaten çalışıyor' "Mevcut sunucu algılandı · $studioUrl"
            }
        } else {
            $script:ready = $false
            $btnStart.IsEnabled = ($null -eq $script:process)
            $btnStop.IsEnabled = $script:ownsProcess -and ($null -ne $script:process)
            $btnOpen.IsEnabled = $false
            $lanText.Text = 'Sunucu başlatılınca gösterilecek'
            if ($script:ownsProcess) {
                Set-State 'starting' 'Sunucu başlatılıyor…' 'Yerel sunucu yanıt verdiğinde portal açılabilir olacak.'
            } else {
                Set-State 'off' 'Sunucu kapalı' 'Başlat düğmesi sunucuyu bu bilgisayarda açar.'
            }
        }
    } catch {
        $script:ready = $false
        $btnStart.IsEnabled = ($null -eq $script:process)
        $btnStop.IsEnabled = $script:ownsProcess -and ($null -ne $script:process)
        $btnOpen.IsEnabled = $false
        if ($script:ownsProcess) { Set-State 'starting' 'Sunucu başlatılıyor…' 'Başlangıç sürerken bu pencere kullanılabilir.' }
        elseif ($script:lastProcessExit -ne $null) { Set-State 'error' 'Sunucu başlatılamadı' "Çıkış kodu: $($script:lastProcessExit). Günlükte ayrıntılar var." }
        else { Set-State 'off' 'Sunucu kapalı' 'Başlat düğmesi sunucuyu bu bilgisayarda açar.' }
    } finally {
        if ($response) { $response.Dispose() }
        $script:healthTask.Dispose()
        $script:healthTask = $null
    }
}

function Start-StudioServer {
    if ($script:process -or $script:ready) { return }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        $script:lastProcessExit = 'npm bulunamadı'
        Write-Log 'Node.js ve npm bulunamadı. Node.js 20 veya üstünü kurup yeniden deneyin.'
        Set-State 'error' 'Node.js / npm bulunamadı' 'Başlatıcı çevrimdışı çalışır; sunucuyu başlatmak için Node.js kurulmalıdır.'
        return
    }
    if (-not (Test-Path (Join-Path $rootDir 'node_modules'))) {
        $script:lastProcessExit = 'bağımlılıklar eksik'
        Write-Log 'node_modules bulunamadı. İnternet gerektirmeyen kullanım için bağımlılıkları önceden kurun.'
        Set-State 'error' 'Bağımlılıklar kurulu değil' 'İlk kurulum için npm install çalıştırın; sonraki yerel açılışlar çevrimdışıdır.'
        return
    }

    $script:lastProcessExit = $null
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $env:ComSpec
    $psi.Arguments = "/d /s /c `"set PORT=$Port&& set HOST=0.0.0.0&& npm run dev`""
    $psi.WorkingDirectory = $rootDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    try {
        $script:process = [System.Diagnostics.Process]::new()
        $script:process.StartInfo = $psi
        $script:process.add_OutputDataReceived({ if ($_.Data) { $script:logQueue.Enqueue($_.Data) } })
        $script:process.add_ErrorDataReceived({ if ($_.Data) { $script:logQueue.Enqueue($_.Data) } })
        if (-not $script:process.Start()) { throw 'Sunucu süreci başlatılamadı.' }
        $script:ownsProcess = $true
        $script:process.BeginOutputReadLine()
        $script:process.BeginErrorReadLine()
        $btnStart.IsEnabled = $false
        $btnStop.IsEnabled = $true
        $btnOpen.IsEnabled = $false
        Set-State 'starting' 'Sunucu başlatılıyor…' "npm run dev · $studioUrl"
        Write-Log "3BStudio sunucusu başlatıldı (PID $($script:process.Id), port $Port)."
    } catch {
        if ($script:process) { $script:process.Dispose(); $script:process = $null }
        $script:ownsProcess = $false
        $script:lastProcessExit = 'başlatma hatası'
        $btnStart.IsEnabled = $true
        $btnStop.IsEnabled = $false
        Write-Log "Başlatma hatası: $($_.Exception.Message)"
        Set-State 'error' 'Sunucu başlatılamadı' 'Ayrıntılar sunucu günlüğünde gösteriliyor.'
    }
}

function Stop-StudioServer {
    if (-not $script:process -or -not $script:ownsProcess) { return }
    $pidToStop = $script:process.Id
    try {
        # Kill the command shell and its npm/node descendants without waiting on the UI thread.
        Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', "$pidToStop", '/T', '/F') -WindowStyle Hidden | Out-Null
        Write-Log 'Başlatıcının açtığı sunucu kapatılıyor…'
    } catch { Write-Log "Durdurma uyarısı: $($_.Exception.Message)" }
    $btnStop.IsEnabled = $false
    $btnOpen.IsEnabled = $false
    Set-State 'starting' 'Sunucu kapatılıyor…' 'Süreç kapanınca durum otomatik güncellenecek.'
}

$titleBar.Add_MouseLeftButtonDown({
    $source = $_.OriginalSource
    while ($source -and $source -ne $titleBar) {
        if ($source -is [System.Windows.Controls.Button]) { return }
        $source = $source.Parent
    }
    try { $window.DragMove() } catch { }
})
(Find 'MinBtn').Add_Click({ $window.WindowState = 'Minimized' })
(Find 'CloseBtn').Add_Click({ $window.Close() })
$btnStart.Add_Click({ Start-StudioServer })
$btnStop.Add_Click({ Stop-StudioServer })
$btnOpen.Add_Click({ if ($script:ready) { Start-Process $studioUrl } })
$btnCopy.Add_Click({
    if ($script:lanUrl) {
        [Windows.Clipboard]::SetText($script:lanUrl)
        Write-Log 'Yerel ağ adresi panoya kopyalandı.'
    }
})
$btnClear.Add_Click({ $logBox.Clear() })

$script:timer = [System.Windows.Threading.DispatcherTimer]::new()
$script:timer.Interval = [TimeSpan]::FromMilliseconds(200)
$script:timer.Add_Tick({
    $line = $null
    while ($script:logQueue.TryDequeue([ref]$line)) { Write-Log $line; $line = $null }

    if ($script:process -and $script:process.HasExited) {
        $script:lastProcessExit = $script:process.ExitCode
        Write-Log "Sunucu süreci kapandı (çıkış kodu $($script:lastProcessExit))."
        $script:process.Dispose()
        $script:process = $null
        $script:ownsProcess = $false
        $script:ready = $false
        $btnStop.IsEnabled = $false
        $btnOpen.IsEnabled = $false
        $btnStart.IsEnabled = $true
        $lanText.Text = 'Sunucu başlatılınca gösterilecek'
        Set-State 'error' 'Sunucu kapandı' "Çıkış kodu: $($script:lastProcessExit). Yeniden başlatabilir veya günlükleri inceleyebilirsiniz."
        $script:nextHealthCheck = [DateTime]::UtcNow.AddMilliseconds(300)
    }

    if ($script:healthTask -and $script:healthTask.IsCompleted) { Complete-HealthCheck }
    Start-HealthCheck
})

$window.Add_Closed({
    $script:timer.Stop()
    if ($script:healthTask) { $script:healthTask.Dispose() }
    $script:httpClient.Dispose()
    if ($script:process -and $script:ownsProcess -and -not $script:process.HasExited) {
        Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', "$($script:process.Id)", '/T', '/F') -WindowStyle Hidden | Out-Null
    }
    if ($script:process) { $script:process.Dispose() }
})

Write-Log "3BStudio başlatıcısı hazır · $studioUrl"
$script:timer.Start()
[void]$window.ShowDialog()
