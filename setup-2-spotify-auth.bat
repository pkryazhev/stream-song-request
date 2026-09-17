@echo off
REM Одноразовая авторизация Spotify (управление воспроизведением).
REM Нужна, только если в .env заполнена группа SPOTIFY_* — если Spotify
REM не настроен (заказ музыки работает только через YouTube), этот шаг
REM можно пропустить.

setlocal
chcp 65001 >nul
title stream-companion — авторизация Spotify
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

echo Сейчас откроется страница авторизации Spotify в браузере.
echo Разреши доступ — окно закроется само, а здесь появится подтверждение.
echo.
call npm run auth:spotify

echo.
pause
