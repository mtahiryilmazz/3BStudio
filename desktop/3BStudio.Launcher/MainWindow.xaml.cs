using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Windows;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;

namespace ThreeBStudio.Launcher;

public partial class MainWindow : Window
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private Process? _serverProcess;
    private string? _repoRoot;
    private bool _webViewInitialized;
    private bool _webViewEventsHooked;
    private bool _serverReady;
    private bool _noBrowser;
    private bool _autoOpenedBrowserFallback;
    private bool _browserFallbackActive;
    private bool _isClosing;
    private int _activePort = 3000;

    public MainWindow()
    {
        InitializeComponent();
        InitializeInitialPort();
        Loaded += MainWindow_Loaded;
        Closing += MainWindow_Closing;
    }

    private void InitializeInitialPort()
    {
        var args = Environment.GetCommandLineArgs();
        string? candidate = null;
        for (int i = 1; i < args.Length; i++)
        {
            if (string.Equals(args[i], "--no-browser", StringComparison.OrdinalIgnoreCase))
            {
                _noBrowser = true;
                continue;
            }
            if (args[i].StartsWith("--port=", StringComparison.OrdinalIgnoreCase))
            {
                candidate = args[i]["--port=".Length..];
                continue;
            }
            if (string.Equals(args[i], "--port", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
            {
                candidate = args[i + 1];
                i++;
                continue;
            }
        }

        candidate ??= Environment.GetEnvironmentVariable("PORT");
        if (int.TryParse(candidate?.Trim(), out var parsed) && parsed >= 1024 && parsed <= 65535)
        {
            _activePort = parsed;
            PortTextBox.Text = parsed.ToString();
        }
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        _repoRoot = FindRepoRoot();
        RepoPathText.Text = _repoRoot ?? "Proje kökü (package.json + server.ts) bulunamadı";

        await RefreshEnvironmentStatusAsync();

        if (_repoRoot != null)
        {
            AppendLog($"[3BStudio] Proje kökü bulundu: {_repoRoot}");
            var ready = await EnsureServerRunningAsync();
            if (ready)
            {
                await OpenDesktopGuiAsync();
            }
        }
        else
        {
            SetStatus("Proje kökü bulunamadı", "#DC2626");
            AppendLog("[HATA] package.json ve server.ts dosyaları üst klasörlerde bulunamadı.");
        }
    }

    private void MainWindow_Closing(object? sender, CancelEventArgs e)
    {
        _isClosing = true;
        StopServerProcess();
        _http.Dispose();
    }

    private static string? FindRepoRoot()
    {
        var candidates = new[]
        {
            Environment.CurrentDirectory,
            AppContext.BaseDirectory
        };

        foreach (var start in candidates)
        {
            var dir = new DirectoryInfo(start);
            for (int depth = 0; depth < 8 && dir != null; depth++)
            {
                var pkg = Path.Combine(dir.FullName, "package.json");
                var srv = Path.Combine(dir.FullName, "server.ts");
                if (File.Exists(pkg) && File.Exists(srv))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }
        }
        return null;
    }

    private int ReadSelectedPort()
    {
        if (int.TryParse(PortTextBox.Text.Trim(), out var parsed) && parsed >= 1024 && parsed <= 65535)
        {
            _activePort = parsed;
        }
        else
        {
            _activePort = 3000;
            PortTextBox.Text = "3000";
        }
        return _activePort;
    }

    private string LocalUrl => $"http://localhost:{_activePort}";
    private string LocalLoopbackUrl => $"http://127.0.0.1:{_activePort}";
    private string HealthProbeUrl => $"{LocalLoopbackUrl}/api/network-info";

    private bool HasInstalledDependencies() =>
        _repoRoot != null &&
        Directory.Exists(Path.Combine(_repoRoot, "node_modules")) &&
        File.Exists(Path.Combine(_repoRoot, "node_modules", ".bin", "tsx.cmd"));

    private string GetLanUrl()
    {
        try
        {
            foreach (var ip in Dns.GetHostAddresses(Dns.GetHostName()))
            {
                if (ip.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ip))
                {
                    return $"http://{ip}:{_activePort}";
                }
            }
        }
        catch
        {
            // ignore network probe errors
        }
        return LocalUrl;
    }

    private async Task RefreshEnvironmentStatusAsync()
    {
        ReadSelectedPort();
        PortalUrlHint.Text = $"Yerel: {LocalUrl} · Ağ/QR: {GetLanUrl()} — Tarayıcıda açar ve telefondan QR aktarımını destekler.";

        var nodeVersion = await RunQuickCommandAsync("node", "--version");
        if (!string.IsNullOrWhiteSpace(nodeVersion))
        {
            NodeStatusText.Text = nodeVersion.Trim();
            NodeStatusText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#16A34A"));
        }
        else
        {
            NodeStatusText.Text = "Bulunamadı (Node.js 20+ kurun)";
            NodeStatusText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#DC2626"));
        }

        if (HasInstalledDependencies())
        {
            DepsStatusText.Text = "Hazır (node_modules)";
            DepsStatusText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#16A34A"));
        }
        else
        {
            DepsStatusText.Text = "Eksik (otomatik kurulacak)";
            DepsStatusText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#D97706"));
        }

        var comfyOnline = await ProbeHttpAsync("http://127.0.0.1:8188/system_stats");
        if (comfyOnline)
        {
            ComfyStatusText.Text = "Bağlı (Aktif GPU)";
            ComfyStatusText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#16A34A"));
        }
        else
        {
            ComfyStatusText.Text = "Kapalı (İsteğe bağlı)";
            ComfyStatusText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#64748B"));
        }

        if (TryGetWebView2Version(out var webViewVersion))
        {
            WebView2StatusText.Text = $"Hazır (v{webViewVersion})";
            WebView2StatusText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#16A34A"));
        }
        else
        {
            WebView2StatusText.Text = "Yok — Tarayıcı modu aktif";
            WebView2StatusText.Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#D97706"));
        }

        var serverUp = await ProbeHttpAsync(HealthProbeUrl, requireSuccess: true);
        _serverReady = serverUp;
        UpdateServerUiState(serverUp);
    }

    private static string? GetConfiguredWebView2Folder()
    {
        var folder = Environment.GetEnvironmentVariable("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER");
        return string.IsNullOrWhiteSpace(folder) ? null : folder.Trim();
    }

    private static bool TryGetWebView2Version(out string? version)
    {
        version = null;
        try
        {
            var browserFolder = GetConfiguredWebView2Folder();
            var v = CoreWebView2Environment.GetAvailableBrowserVersionString(browserFolder);
            if (!string.IsNullOrWhiteSpace(v))
            {
                version = v.Trim();
                return true;
            }
            return false;
        }
        catch
        {
            version = null;
            return false;
        }
    }

    private void UpdateServerUiState(bool running)
    {
        if (running)
        {
            var statusLabel = _browserFallbackActive
                ? $"Tarayıcıda Açık · :{_activePort}"
                : $"Çalışıyor · :{_activePort}";
            SetStatus(statusLabel, "#22C55E");
            BtnToggleServer.Content = "Sunucuyu Durdur";
        }
        else
        {
            _browserFallbackActive = false;
            SetStatus("Durduruldu", "#94A3B8");
            BtnToggleServer.Content = "Sunucuyu Başlat";
        }
    }

    private void SetStatus(string text, string hexColor)
    {
        if (_isClosing || Dispatcher.HasShutdownStarted || Dispatcher.HasShutdownFinished) return;
        if (Dispatcher.CheckAccess())
        {
            StatusText.Text = text;
            StatusDot.Fill = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hexColor));
            return;
        }
        Dispatcher.BeginInvoke(() =>
        {
            if (_isClosing || Dispatcher.HasShutdownStarted || Dispatcher.HasShutdownFinished) return;
            StatusText.Text = text;
            StatusDot.Fill = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hexColor));
        });
    }

    private void AppendLog(string line)
    {
        if (_isClosing || Dispatcher.HasShutdownStarted || Dispatcher.HasShutdownFinished) return;
        if (Dispatcher.CheckAccess())
        {
            ConsoleOutputBox.AppendText(line + Environment.NewLine);
            if (ConsoleOutputBox.Text.Length > 80_000)
            {
                ConsoleOutputBox.Text = ConsoleOutputBox.Text[^50_000..];
            }
            ConsoleOutputBox.ScrollToEnd();
            return;
        }
        Dispatcher.BeginInvoke(() =>
        {
            if (_isClosing || Dispatcher.HasShutdownStarted || Dispatcher.HasShutdownFinished) return;
            ConsoleOutputBox.AppendText(line + Environment.NewLine);
            if (ConsoleOutputBox.Text.Length > 80_000)
            {
                ConsoleOutputBox.Text = ConsoleOutputBox.Text[^50_000..];
            }
            ConsoleOutputBox.ScrollToEnd();
        });
    }

    private async Task<bool> ProbeHttpAsync(string url, bool requireSuccess = false)
    {
        try
        {
            using var resp = await _http.GetAsync(url);
            return requireSuccess
                ? resp.IsSuccessStatusCode
                : (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 500;
        }
        catch
        {
            return false;
        }
    }

    private static async Task<string?> RunQuickCommandAsync(string fileName, string args)
    {
        try
        {
            using var p = new Process();
            p.StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = args,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            p.Start();
            var output = await p.StandardOutput.ReadToEndAsync();
            await p.WaitForExitAsync();
            return p.ExitCode == 0 ? output : null;
        }
        catch
        {
            return null;
        }
    }

    private async Task<bool> RunNpmInstallAsync()
    {
        if (_repoRoot == null) return false;
        SetStatus("npm install çalışıyor...", "#F59E0B");
        AppendLog("[3BStudio] Bağımlılıklar kuruluyor (npm install)...");

        using var proc = new Process();
        proc.StartInfo = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = "/c npm install",
            WorkingDirectory = _repoRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        proc.OutputDataReceived += (_, e) => { if (e.Data != null) AppendLog(e.Data); };
        proc.ErrorDataReceived += (_, e) => { if (e.Data != null) AppendLog(e.Data); };
        proc.Start();
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        await proc.WaitForExitAsync();

        await RefreshEnvironmentStatusAsync();
        if (proc.ExitCode == 0)
        {
            AppendLog("[3BStudio] npm install başarıyla tamamlandı.");
            return true;
        }
        AppendLog($"[HATA] npm install çıkış kodu: {proc.ExitCode}");
        return false;
    }

    private async Task<bool> EnsureServerRunningAsync()
    {
        ReadSelectedPort();
        if (await ProbeHttpAsync(HealthProbeUrl, requireSuccess: true))
        {
            _serverReady = true;
            UpdateServerUiState(true);
            return true;
        }

        if (_repoRoot == null)
        {
            MessageBox.Show("Proje kökü (package.json + server.ts) bulunamadı.", "3BStudio Başlatıcı", MessageBoxButton.OK, MessageBoxImage.Error);
            return false;
        }

        // İlk klonlamada node_modules yoksa otomatik kur
        if (!HasInstalledDependencies())
        {
            var okInstall = await RunNpmInstallAsync();
            if (!okInstall) return false;
        }

        SetStatus($"Sunucu başlatılıyor (:{_activePort})...", "#F59E0B");
        WebViewLoadingDetail.Text = $"Yerel 3BStudio sunucusu http://localhost:{_activePort} üzerinde başlatılıyor...";
        AppendLog($"[3BStudio] Yerel sunucu başlatılıyor: npm run dev (PORT={_activePort})");

        var startInfo = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = "/c npm run dev",
            WorkingDirectory = _repoRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        startInfo.Environment["PORT"] = _activePort.ToString();
        startInfo.Environment["HOST"] = "0.0.0.0";

        _serverProcess = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        _serverProcess.OutputDataReceived += (_, e) => { if (e.Data != null) AppendLog(e.Data); };
        _serverProcess.ErrorDataReceived += (_, e) => { if (e.Data != null) AppendLog(e.Data); };
        _serverProcess.Exited += (_, _) =>
        {
            _serverReady = false;
            if (_isClosing || Dispatcher.HasShutdownStarted || Dispatcher.HasShutdownFinished) return;
            Dispatcher.BeginInvoke(() => UpdateServerUiState(false));
            AppendLog("[3BStudio] Yerel sunucu durduruldu.");
        };

        try
        {
            _serverProcess.Start();
            _serverProcess.BeginOutputReadLine();
            _serverProcess.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            AppendLog($"[HATA] Sunucu başlatılamadı: {ex.Message}");
            SetStatus("Başlatma hatası", "#DC2626");
            return false;
        }

        // Sunucu HTTP yanıt verene kadar bekle (maksimum 45 sn)
        for (int i = 0; i < 90; i++)
        {
            if (_serverProcess == null || _serverProcess.HasExited)
            {
                SetStatus("Sunucu beklenmedik şekilde kapandı", "#DC2626");
                return false;
            }
            if (await ProbeHttpAsync(HealthProbeUrl, requireSuccess: true))
            {
                _serverReady = true;
                UpdateServerUiState(true);
                AppendLog($"[3BStudio] Hazır! Web Portalı: {LocalUrl} | Ağ/QR: {GetLanUrl()}");
                return true;
            }
            await Task.Delay(500);
        }

        SetStatus("Zaman aşımı", "#DC2626");
        AppendLog("[HATA] Sunucu 45 saniye içinde yanıt vermedi. Konsol çıktısını kontrol edin.");
        return false;
    }

    private void StopServerProcess()
    {
        if (_serverProcess == null) return;
        try
        {
            if (!_serverProcess.HasExited)
            {
                // Tüm alt Node/tsx/vite süreç ağacını temiz kapat
                var killer = new Process
                {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName = "taskkill",
                        Arguments = $"/PID {_serverProcess.Id} /T /F",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                    }
                };
                killer.Start();
                killer.WaitForExit(3000);
            }
        }
        catch
        {
            // ignore teardown error
        }
        finally
        {
            _serverProcess.Dispose();
            _serverProcess = null;
            _serverReady = false;
            UpdateServerUiState(false);
        }
    }

    private bool OpenBrowserUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });
            return true;
        }
        catch (Exception primaryEx)
        {
            AppendLog($"[UYARI] Doğrudan tarayıcı başlatılamadı ({primaryEx.Message}), cmd start deneniyor...");
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = $"/c start \"\" \"{url}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                return true;
            }
            catch (Exception fallbackEx)
            {
                AppendLog($"[HATA] Tarayıcı açılamadı: {fallbackEx.Message}");
                return false;
            }
        }
    }

    private void FallbackToBrowser(string reason, bool forceOpen = false)
    {
        WebViewLoadingOverlay.Visibility = Visibility.Collapsed;
        DesktopGuiPanel.Visibility = Visibility.Collapsed;
        DashboardPanel.Visibility = Visibility.Visible;
        _browserFallbackActive = true;
        UpdateServerUiState(_serverReady);

        AppendLog($"[UYARI] {reason} Web Portalı varsayılan tarayıcıda açılıyor...");

        if (_noBrowser && !forceOpen)
        {
            AppendLog($"[3BStudio] --no-browser etkin; otomatik tarayıcı açma atlandı. Portal adresi: {LocalUrl}");
            return;
        }

        if (forceOpen || !_autoOpenedBrowserFallback)
        {
            _autoOpenedBrowserFallback = true;
            if (OpenBrowserUrl(LocalUrl))
            {
                AppendLog($"[3BStudio] Web Portalı varsayılan tarayıcıda açıldı: {LocalUrl}");
            }
        }
    }

    private async Task InitializeWebViewEnvironmentAsync()
    {
        var browserFolder = GetConfiguredWebView2Folder();
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var sharedUserDataDir = Path.Combine(localAppData, "3BStudio", "WebView2");

        try
        {
            var env = await CoreWebView2Environment.CreateAsync(browserFolder, sharedUserDataDir);
            await StudioWebView.EnsureCoreWebView2Async(env);
        }
        catch (Exception primaryEx)
        {
            AppendLog($"[UYARI] Paylaşılan WebView2 profili açılamadı ({primaryEx.Message}); izole profil deneniyor...");
            var isolatedUserDataDir = Path.Combine(localAppData, "3BStudio", $"WebView2-{_activePort}-{Environment.ProcessId}");
            Directory.CreateDirectory(isolatedUserDataDir);
            var fallbackEnv = await CoreWebView2Environment.CreateAsync(browserFolder, isolatedUserDataDir);
            await StudioWebView.EnsureCoreWebView2Async(fallbackEnv);
        }
    }

    private void CoreWebView2_NavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        Dispatcher.Invoke(() =>
        {
            WebViewLoadingOverlay.Visibility = Visibility.Collapsed;
            if (!e.IsSuccess && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
            {
                FallbackToBrowser($"WebView2 sayfa yüklemesi başarısız ({e.WebErrorStatus});");
            }
        });
    }

    private void CoreWebView2_ProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Dispatcher.Invoke(() =>
        {
            _webViewInitialized = false;
            _webViewEventsHooked = false;
            FallbackToBrowser($"WebView2 işlemi beklenmedik şekilde sonlandı ({e.ProcessFailedKind});");
        });
    }

    private async Task OpenDesktopGuiAsync(bool userInitiated = false)
    {
        var ok = await EnsureServerRunningAsync();
        if (!ok)
        {
            WebViewLoadingOverlay.Visibility = Visibility.Collapsed;
            DashboardPanel.Visibility = Visibility.Visible;
            DesktopGuiPanel.Visibility = Visibility.Collapsed;
            return;
        }

        if (!TryGetWebView2Version(out _))
        {
            FallbackToBrowser("WebView2 Runtime bulunamadı veya başlatılamadı;", forceOpen: userInitiated);
            return;
        }

        DashboardPanel.Visibility = Visibility.Collapsed;
        DesktopGuiPanel.Visibility = Visibility.Visible;
        WebViewLoadingOverlay.Visibility = Visibility.Visible;

        try
        {
            if (!_webViewInitialized)
            {
                await InitializeWebViewEnvironmentAsync();
                StudioWebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                StudioWebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                StudioWebView.CoreWebView2.Settings.AreDevToolsEnabled = true;
                if (!_webViewEventsHooked)
                {
                    StudioWebView.CoreWebView2.NavigationCompleted += CoreWebView2_NavigationCompleted;
                    StudioWebView.CoreWebView2.ProcessFailed += CoreWebView2_ProcessFailed;
                    _webViewEventsHooked = true;
                }
                _webViewInitialized = true;
            }

            _browserFallbackActive = false;
            UpdateServerUiState(_serverReady);

            var targetUri = new Uri(LocalUrl);
            if (StudioWebView.Source != null &&
                Uri.Compare(StudioWebView.Source, targetUri, UriComponents.AbsoluteUri, UriFormat.SafeUnescaped, StringComparison.OrdinalIgnoreCase) == 0)
            {
                WebViewLoadingOverlay.Visibility = Visibility.Collapsed;
            }
            else
            {
                StudioWebView.Source = targetUri;
            }
        }
        catch (Exception ex)
        {
            FallbackToBrowser($"WebView2 başlatılamadı ({ex.Message});", forceOpen: userInitiated);
        }
    }

    private async void BtnShowDesktopGui_Click(object sender, RoutedEventArgs e)
    {
        await OpenDesktopGuiAsync(userInitiated: true);
    }

    private async void BtnOpenBrowser_Click(object sender, RoutedEventArgs e)
    {
        var ok = await EnsureServerRunningAsync();
        if (!ok) return;

        if (OpenBrowserUrl(LocalUrl))
        {
            AppendLog($"[3BStudio] Web Portalı varsayılan tarayıcıda açıldı: {LocalUrl}");
        }
    }

    private void BtnShowDashboard_Click(object sender, RoutedEventArgs e)
    {
        DesktopGuiPanel.Visibility = Visibility.Collapsed;
        DashboardPanel.Visibility = Visibility.Visible;
    }

    private void BtnReloadWebView_Click(object sender, RoutedEventArgs e)
    {
        if (_webViewInitialized && StudioWebView.CoreWebView2 != null)
        {
            StudioWebView.CoreWebView2.Reload();
        }
    }

    private async void BtnToggleServer_Click(object sender, RoutedEventArgs e)
    {
        if (_serverProcess != null && !_serverProcess.HasExited || _serverReady)
        {
            StopServerProcess();
            AppendLog("[3BStudio] Sunucu kullanıcı tarafından durduruldu.");
        }
        else
        {
            await EnsureServerRunningAsync();
        }
    }

    private async void BtnInstallDeps_Click(object sender, RoutedEventArgs e)
    {
        BtnInstallDeps.IsEnabled = false;
        try
        {
            await RunNpmInstallAsync();
        }
        finally
        {
            BtnInstallDeps.IsEnabled = true;
        }
    }

    private async void BtnCheckEnv_Click(object sender, RoutedEventArgs e)
    {
        await RefreshEnvironmentStatusAsync();
    }

    private void BtnCopyLanUrl_Click(object sender, RoutedEventArgs e)
    {
        var lanUrl = GetLanUrl();
        Clipboard.SetText(lanUrl);
        AppendLog($"[3BStudio] Yerel ağ adresi panoya kopyalandı: {lanUrl}");
    }

    private void BtnClearLogs_Click(object sender, RoutedEventArgs e)
    {
        ConsoleOutputBox.Clear();
    }
}
