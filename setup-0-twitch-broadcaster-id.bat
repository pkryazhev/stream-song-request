@echo off
REM ENCODING WARNING (keep this comment in plain ASCII, always safe to read):
REM This file must be saved as Windows-1251 (ANSI/Cyrillic), NOT UTF-8,
REM with CRLF line endings. cmd.exe's batch parser can corrupt multi-byte
REM UTF-8 Cyrillic mid-line (even with "chcp 65001"), and LF-only line
REM endings can make it misparse lines. If you edit this file, re-save it
REM as Windows-1251 with CRLF.
REM
REM ”знаЄт числовой id канала Twitch по логину Ч нужен дл€
REM TWITCH_BROADCASTER_ID в .env (это не то же самое, что сам логин).
REM «апускать нужно уже после того, как заполнены TWITCH_CLIENT_ID и
REM TWITCH_CLIENT_SECRET в .env.

setlocal
chcp 1251 >nul
title stream-companion Ч id канала Twitch
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
    echo заполни .env ^(хот€ бы TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET^)
    echo и только потом возвращайс€ сюда.
    echo.
    pause
    exit /b 1
)

set /p BROADCASTER_LOGIN=¬веди логин канала (как в twitch.tv/логин) и нажми Enter:
if "%BROADCASTER_LOGIN%"=="" (
    echo Ћогин не введЄн, отмен€ю.
    echo.
    pause
    exit /b 1
)

echo.
call npm run whoami:twitch -- %BROADCASTER_LOGIN%

echo.
echo —копируй полученный числовой id в TWITCH_BROADCASTER_ID в файле .env.
echo.
pause
