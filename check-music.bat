@echo off
REM ENCODING WARNING (keep this comment in plain ASCII, always safe to read):
REM This file must be saved as Windows-1251 (ANSI/Cyrillic), NOT UTF-8,
REM with CRLF line endings. cmd.exe's batch parser can corrupt multi-byte
REM UTF-8 Cyrillic mid-line (even with "chcp 65001"), and LF-only line
REM endings can make it misparse lines. If you edit this file, re-save it
REM as Windows-1251 with CRLF.
REM
REM Проверка перед стримом: музыка заказывается и играет — дефолтный
REM плейлист, заказ по ссылке Spotify, по названию, по ссылке YouTube и по
REM ссылке Яндекс Музыки (см. scripts/music-check.ts). Каждый трек звучит
REM несколько секунд. Само приложение на время проверки должно быть закрыто.

setlocal
chcp 1251 >nul
title stream-companion — проверка музыки
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден. Установи его: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [ОШИБКА] Файл .env не найден — сначала запусти start.bat хотя бы раз
    echo и заполни .env.
    echo.
    pause
    exit /b 1
)

echo Проверяю заказ и воспроизведение музыки. Займёт около минуты,
echo каждый трек будет звучать несколько секунд.
echo Spotify должен быть открыт, само приложение (start.bat) — закрыто.
echo.

call npm run --silent check:music
set RESULT=%errorlevel%

echo.
if "%RESULT%"=="0" (
    echo Проверка пройдена.
) else (
    echo [ВНИМАНИЕ] Проверка НЕ пройдена — причины см. выше.
)
echo.
pause
exit /b %RESULT%
