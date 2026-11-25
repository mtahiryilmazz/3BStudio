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
    private bool _serverReady;
    private int _activePort = 3000;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += MainWindow_Loaded;
        Closing += MainWindow_Closing;
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

        if (_repoRoot != null && Directory.Exists(Path.Combine(_repoRoot, "node_modules")))
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

        var serverUp = await ProbeHttpAsync(LocalLoopbackUrl);
        _serverReady = serverUp;
        UpdateServerUiState(serverUp);
    }

    private void UpdateServerUiState(bool running)
    {
        if (running)
        {
            SetStatus($"Çalışıyor · :{ _activePort }", "#22C55E");
            BtnToggleServer.Content = "Sunucuyu Durdur";
        }
        else
        {
            SetStatus("Durduruldu", "#94A3B8");
            BtnToggleServer.Content = "Sunucuyu Başlat";
        }
    }

    private void SetStatus(string text, string hexColor)
    {
        Dispatcher.Invoke(() =>
        {
            StatusText.Text = text;
            StatusDot.Fill = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hexColor));
        });
    }

    private void AppendLog(string line)
    {
        Dispatcher.Invoke(() =>
        {
            ConsoleOutputBox.AppendText(line + Environment.NewLine);
            if (ConsoleOutputBox.Text.Length > 80_000)
            {
                ConsoleOutputBox.Text = ConsoleOutputBox.Text[^50_000..];
            }
            ConsoleOutputBox.ScrollToEnd();
        });
    }

    private async Task<bool> ProbeHttpAsync(string url)
    {
        try
        {
            using var resp = await _http.GetAsync(url);
            return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 500;
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
        if (await ProbeHttpAsync(LocalLoopbackUrl))
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
        if (!Directory.Exists(Path.Combine(_repoRoot, "node_modules")))
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
            Dispatcher.Invoke(() => UpdateServerUiState(false));
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
            if (await ProbeHttpAsync(LocalLoopbackUrl))
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

    private async Task OpenDesktopGuiAsync()
    {
        DashboardPanel.Visibility = Visibility.Collapsed;
        DesktopGuiPanel.Visibility = Visibility.Visible;
        WebViewLoadingOverlay.Visibility = Visibility.Visible;

        var ok = await EnsureServerRunningAsync();
        if (!ok)
        {
            WebViewLoadingOverlay.Visibility = Visibility.Collapsed;
            DashboardPanel.Visibility = Visibility.Visible;
            DesktopGuiPanel.Visibility = Visibility.Collapsed;
            return;
        }

        try
        {
            if (!_webViewInitialized)
            {
                var userDataDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "3BStudio",
                    "WebView2"
                );
                var env = await CoreWebView2Environment.CreateAsync(null, userDataDir);
                await StudioWebView.EnsureCoreWebView2Async(env);
                StudioWebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                StudioWebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                StudioWebView.CoreWebView2.Settings.AreDevToolsEnabled = true;
                _webViewInitialized = true;
            }

            StudioWebView.Source = new Uri(LocalUrl);
            WebViewLoadingOverlay.Visibility = Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            WebViewLoadingOverlay.Visibility = Visibility.Collapsed;
            DashboardPanel.Visibility = Visibility.Visible;
            DesktopGuiPanel.Visibility = Visibility.Collapsed;
            AppendLog($"[UYARI] WebView2 başlatılamadı: {ex.Message}");
            MessageBox.Show(
                "Microsoft Edge WebView2 Runtime bulunamadı veya başlatılamadı.\nWeb Portalı butonunu kullanarak tarayıcıdan devam edebilir veya WebView2 Runtime kurabilirsiniz.",
                "WebView2 Uyarısı",
                MessageBoxButton.OK,
                MessageBoxImage.Warning
            );
        }
    }

    private async void BtnShowDesktopGui_Click(object sender, RoutedEventArgs e)
    {
        await OpenDesktopGuiAsync();
    }

    private async void BtnOpenBrowser_Click(object sender, RoutedEventArgs e)
    {
        var ok = await EnsureServerRunningAsync();
        if (!ok) return;

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = LocalUrl,
                UseShellExecute = true,
            });
            AppendLog($"[3BStudio] Web Portalı varsayılan tarayıcıda açıldı: {LocalUrl}");
        }
        catch (Exception ex)
        {
            AppendLog($"[HATA] Tarayıcı açılamadı: {ex.Message}");
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
