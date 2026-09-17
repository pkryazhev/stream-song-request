@echo off
REM Одноразовая авторизация Twitch (чат + проверка фолловеров).
REM Открывает ссылку авторизации в браузере — нужно один раз разрешить
REM доступ, после чего токен с автообновлением сохранится на диск
REM (см. TWITCH_CHAT_TOKEN_FILE в .env), и запускать это снова не нужно
REM (кроме случая, если сам решишь отозвать доступ в настройках Twitch).

setlocal
chcp 65001 >nul
title stream-companion — авторизация Twitch
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

echo Сейчас откроется страница авторизации Twitch в браузере.
echo Разреши доступ — окно закроется само, а здесь появится подтверждение.
echo.
call npm run auth:twitch

echo.
pause
