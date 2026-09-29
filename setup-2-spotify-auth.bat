@echo off
REM ENCODING WARNING (keep this comment in plain ASCII, always safe to read):
REM This file must be saved as Windows-1251 (ANSI/Cyrillic), NOT UTF-8,
REM with CRLF line endings. cmd.exe's batch parser can corrupt multi-byte
REM UTF-8 Cyrillic mid-line (even with "chcp 65001"), and LF-only line
REM endings can make it misparse lines. If you edit this file, re-save it
REM as Windows-1251 with CRLF.
REM
REM ќдноразова€ авторизаци€ Spotify (управление воспроизведением).
REM Ќужна, только если в .env заполнена группа SPOTIFY_* Ч если Spotify
REM не настроен (заказ музыки работает только через YouTube), этот шаг
REM можно пропустить.

setlocal
chcp 1251 >nul
title stream-companion Ч авторизаци€ Spotify
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

echo —ейчас откроетс€ страница авторизации Spotify в браузере.
echo –азреши доступ Ч окно закроетс€ само, а здесь по€витс€ подтверждение.
echo.
call npm run auth:spotify

echo.
pause
