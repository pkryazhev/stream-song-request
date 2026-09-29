@echo off
REM ENCODING WARNING (keep this comment in plain ASCII, always safe to read):
REM This file must be saved as Windows-1251 (ANSI/Cyrillic), NOT UTF-8,
REM with CRLF line endings. cmd.exe's batch parser can corrupt multi-byte
REM UTF-8 Cyrillic mid-line (even with "chcp 65001"), and LF-only line
REM endings can make it misparse lines. If you edit this file, re-save it
REM as Windows-1251 with CRLF.
REM
REM ќдноразова€ авторизаци€ Twitch (чат + проверка фолловеров).
REM ќткрывает ссылку авторизации в браузере Ч нужно один раз разрешить
REM доступ, после чего токен с автообновлением сохранитс€ на диск
REM (см. TWITCH_CHAT_TOKEN_FILE в .env), и запускать это снова не нужно
REM (кроме случа€, если сам решишь отозвать доступ в настройках Twitch).

setlocal
chcp 1251 >nul
title stream-companion Ч авторизаци€ Twitch
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

echo —ейчас откроетс€ страница авторизации Twitch в браузере.
echo –азреши доступ Ч окно закроетс€ само, а здесь по€витс€ подтверждение.
echo.
call npm run auth:twitch

echo.
pause
