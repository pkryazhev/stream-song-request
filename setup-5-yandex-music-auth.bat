@echo off
REM ENCODING WARNING (keep this comment in plain ASCII, always safe to read):
REM This file must be saved as Windows-1251 (ANSI/Cyrillic), NOT UTF-8.
REM cmd.exe's batch parser can corrupt multi-byte UTF-8 Cyrillic mid-line.
REM If you edit this file, re-save it as Windows-1251.
REM
REM Одноразовое получение токена Яндекс Музыки (YANDEX_MUSIC_TOKEN в .env).
REM Нужно для заказов по ссылкам на Яндекс Музыку и для дефолтного плейлиста
REM из Яндекс Музыки. Если Яндекс Музыка не нужна - этот шаг можно пропустить.
REM Токен живёт около года; когда протухнет - просто запусти этот файл снова.

setlocal
chcp 1251 >nul
title stream-companion - авторизация Яндекс Музыки
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

echo Сейчас откроется страница входа Яндекса в браузере.
echo Войди в аккаунт с подпиской Плюс и разреши доступ, затем скопируй
echo адрес из адресной строки браузера и вставь его сюда
echo ^(правый клик мышью в этом окне - вставка^).
echo.
call npm run auth:yandex

echo.
pause
