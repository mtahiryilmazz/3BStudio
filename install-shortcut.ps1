# Masaüstüne 3BStudio kısayolu oluşturur.
# Kullanim: powershell -ExecutionPolicy Bypass -File install-shortcut.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root '3BStudio-Baslat.cmd'
if (-not (Test-Path $target)) {
    throw "3BStudio-Baslat.cmd bulunamadı: $target"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop '3BStudio.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$shortcut.Description = '3BStudio yerel modelleme stüdyosu'
$shortcut.Save()

Write-Host "Kisayol olusturuldu: $linkPath"
