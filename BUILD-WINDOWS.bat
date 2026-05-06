@echo off
chcp 65001 >nul
title STT HR — Build za Windows

echo.
echo  ==========================================
echo   STT HR - Build za Windows (.exe)
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

:: Provjeri Python
python --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo [GREŠKA] Python nije instaliran!
    echo Preuzmi sa: https://python.org
    pause
    exit /b 1
)

echo [1/4] Instaliram Node pakete...
call npm install
IF %ERRORLEVEL% NEQ 0 (
    echo [GREŠKA] npm install nije uspio.
    pause
    exit /b 1
)

echo.
echo [2/4] Generiram ikone...
python scripts\make_icons.py
IF %ERRORLEVEL% NEQ 0 (
    echo [UPOZORENJE] Generisanje ikona nije uspjelo, nastavlja se bez custom ikone...
)

echo.
echo [3/4] Buildam Windows .exe installer...
call npm run build:win
IF %ERRORLEVEL% NEQ 0 (
    echo [GREŠKA] Build nije uspio.
    pause
    exit /b 1
)

echo.
echo [4/4] Gotovo!
echo.
echo  ✅ Installer se nalazi u: dist\
echo     Traži fajl:  STT HR Setup X.X.X.exe
echo.
echo  Instaliraj dvoklikom i testiraj!
echo.
pause
