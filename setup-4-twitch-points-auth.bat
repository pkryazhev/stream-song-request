@echo off
REM ENCODING WARNING (keep this comment in plain ASCII, always safe to read):
REM This file must be saved as Windows-1251 (ANSI/Cyrillic), NOT UTF-8.
REM cmd.exe's batch parser can corrupt multi-byte UTF-8 Cyrillic mid-line.
REM If you edit this file, re-save it as Windows-1251.
REM
REM Одноразовая авторизация СТРИМЕРА для заказа музыки за баллы канала
REM (MUSIC_REQUEST_MODE=points в .env). В браузере нужно быть залогиненным
REM аккаунтом канала, а не ботом: Twitch даёт управлять наградами только
REM самому стримеру. Токен сохранится в TWITCH_BROADCASTER_TOKEN_FILE.

setlocal
chcp 1251 >nul
title stream-companion - авторизация стримера (баллы канала)
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [Ошибка] Node.js не найден. Установи его: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [Ошибка] Файл .env не найден - сначала запусти start.bat один раз,
    echo заполни .env и только потом возвращайся сюда.
    echo.
    pause
    exit /b 1
)

echo Сейчас откроется страница авторизации Twitch в браузере.
echo ВАЖНО: войди АККАУНТОМ КАНАЛА ^(не ботом^) и разреши доступ -
echo здесь появится подтверждение.
echo.
call npm run auth:twitch-points

echo.
pause
