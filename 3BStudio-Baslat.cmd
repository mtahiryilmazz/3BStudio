@echo off
rem 3BStudio - cift tikla yerel baslatici
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-studio.ps1" %*
if errorlevel 1 (
    echo.
    echo [3BStudio] Baslatma sirasinda bir hata olustu ^(cikis kodu: %errorlevel%^).
    pause
)
endlocal
