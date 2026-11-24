# Masaustune "Photo2Print 3D Studio" kisayolu olusturur.
# Kullanim: powershell -ExecutionPolicy Bypass -File install-shortcut.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root 'Photo2Print-Baslat.cmd'
if (-not (Test-Path $target)) {
    throw "Photo2Print-Baslat.cmd bulunamadi: $target"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'Photo2Print 3D Studio.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$shortcut.Description = 'Photo2Print 3D Studio baslatici (Vite + API)'
$shortcut.Save()

Write-Host "Kisayol olusturuldu: $linkPath"
