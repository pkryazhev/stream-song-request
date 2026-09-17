@echo off
REM Узнаёт числовой id канала Twitch по логину — нужен для
REM TWITCH_BROADCASTER_ID в .env (это не то же самое, что сам логин).
REM Запускать нужно уже после того, как заполнены TWITCH_CLIENT_ID и
REM TWITCH_CLIENT_SECRET в .env.

setlocal
chcp 65001 >nul
title stream-companion — id канала Twitch
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
    echo заполни .env ^(хотя бы TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET^)
    echo и только потом возвращайся сюда.
    echo.
    pause
    exit /b 1
)

set /p BROADCASTER_LOGIN=Введи логин канала (как в twitch.tv/логин) и нажми Enter:
if "%BROADCASTER_LOGIN%"=="" (
    echo Логин не введён, отменяю.
    echo.
    pause
    exit /b 1
)

echo.
call npm run whoami:twitch -- %BROADCASTER_LOGIN%

echo.
echo Скопируй полученный числовой id в TWITCH_BROADCASTER_ID в файле .env.
echo.
pause
