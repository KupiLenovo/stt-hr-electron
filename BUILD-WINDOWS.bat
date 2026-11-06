@echo off
chcp 65001 >nul
title Vault aiERP — Build za Windows

echo.
echo  ==========================================
echo   Vault aiERP - Build za Windows (.exe)
echo  ==========================================
echo.

:: Provjeri Node.js
node --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo [GREŠKA] Node.js nije instaliran!
    echo Preuzmi sa: https://nodejs.org  ^(preporučeno: 20 LTS^)
    pause
    exit /b 1
)

:: Ikone (build\icon.ico, icon.png, icon_*.png) su commitane — generišu se samo kad se znak promijeni:
::   node scripts\ikone.js   (treba Playwright, vidi komentar u skripti)

echo [1/3] Instaliram Node pakete...
call npm install
IF %ERRORLEVEL% NEQ 0 (
    echo [GREŠKA] npm install nije uspio.
    pause
    exit /b 1
)

echo.
echo [2/3] Buildam Windows .exe installer...
call npm run build:win
IF %ERRORLEVEL% NEQ 0 (
    echo [GREŠKA] Build nije uspio.
    pause
    exit /b 1
)

echo.
echo [3/3] Gotovo!
echo.
echo  ✅ Installer se nalazi u: dist\
echo     Traži fajl:  Vault-aiERP-Setup-X.X.X.exe
echo.
echo  Instaliraj dvoklikom i testiraj!
echo.
pause
