@echo off
REM Показывает список устройств Spotify Connect, видимых для аккаунта прямо
REM сейчас — нужно, чтобы узнать точное имя для SPOTIFY_DEVICE_NAME в .env.
REM Перед запуском открой Spotify (desktop/mobile/web) на том устройстве,
REM где должна играть музыка — иначе список будет пустым.

setlocal
chcp 65001 >nul
title stream-companion — устройства Spotify
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [Ошибка] Node.js не найден. Установи его: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [Ошибка] Файл .env не найден — сначала запусти start.bat один раз,
    echo заполни .env и только потом возвращайся сюда.
    echo.
    pause
    exit /b 1
)

echo Открой Spotify на устройстве, где должна играть музыка, и убедись,
echo что он там реально запущен (не обязательно что-то играет — просто
echo открыт). Затем нажми любую клавишу, чтобы получить список устройств.
pause >nul
echo.

call npm run devices:spotify

echo.
echo Скопируй нужное имя устройства из списка выше в SPOTIFY_DEVICE_NAME
echo в файле .env.
echo.
pause
