@echo off
REM ENCODING WARNING (keep this comment in plain ASCII, always safe to read):
REM This file must be saved as Windows-1251 (ANSI/Cyrillic), NOT UTF-8,
REM with CRLF line endings. cmd.exe's batch parser can corrupt multi-byte
REM UTF-8 Cyrillic mid-line (even with "chcp 65001"), and LF-only line
REM endings can make it misparse lines. If you edit this file, re-save it
REM as Windows-1251 with CRLF.
REM
REM ѕоказывает список устройств Spotify Connect, видимых дл€ аккаунта пр€мо
REM сейчас Ч нужно, чтобы узнать точное им€ дл€ SPOTIFY_DEVICE_NAME в .env.
REM ѕеред запуском открой Spotify (desktop/mobile/web) на том устройстве,
REM где должна играть музыка Ч иначе список будет пустым.

setlocal
chcp 1251 >nul
title stream-companion Ч устройства Spotify
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [ќшибка] Node.js не найден. ”станови его: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [ќшибка] ‘айл .env не найден Ч сначала запусти start.bat один раз,
    echo заполни .env и только потом возвращайс€ сюда.
    echo.
    pause
    exit /b 1
)

echo ќткрой Spotify на устройстве, где должна играть музыка, и убедись,
echo что он там реально запущен (не об€зательно что-то играет Ч просто
echo открыт). «атем нажми любую клавишу, чтобы получить список устройств.
pause >nul
echo.

call npm run devices:spotify

echo.
echo —копируй нужное им€ устройства из списка выше в SPOTIFY_DEVICE_NAME
echo в файле .env.
echo.
pause
