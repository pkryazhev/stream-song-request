@echo off
REM ENCODING WARNING (keep this comment in plain ASCII, always safe to read):
REM This file must be saved as Windows-1251 (ANSI/Cyrillic), NOT UTF-8.
REM cmd.exe's batch parser has a long-standing bug where multi-byte UTF-8
REM Cyrillic sequences can get corrupted mid-line (even with "chcp 65001"
REM active), which breaks a line at the wrong byte and makes the tail of a
REM word look like a stray command ("... is not recognized as an internal
REM or external command"). Windows-1251 is single-byte, so this class of
REM bug cannot happen. If you edit this file, re-save it as Windows-1251 -
REM do NOT let a UTF-8-only editor/tool silently convert it back.
REM
REM Запуск stream-companion двойным кликом, без консольных команд.
REM При первом запуске (если .env ещё нет) создаёт его из .env.example
REM и открывает в Блокноте для заполнения, вместо того чтобы сразу падать
REM с непонятной ошибкой про отсутствующие переменные окружения.

setlocal
chcp 1251 >nul
title stream-companion
cd /d "%~dp0"

echo ================================================
echo   stream-companion
echo ================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [Ошибка] Node.js не найден.
    echo.
    echo Установи Node.js версии 22.6 или новее: https://nodejs.org/
    echo После установки закрой это окно и запусти start.bat ещё раз
    echo ^(если Node только что установлен — может понадобиться перезайти
    echo  в Windows, чтобы обновился PATH^).
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    if exist ".env.example" (
        echo [Первый запуск] Файл .env не найден — создаю его из .env.example.
        copy /y ".env.example" ".env" >nul
        echo Открываю .env в Блокноте — заполни нужные значения ^(см. подсказки
        echo прямо в файле^) и сохрани его.
        echo.
        notepad ".env"
        echo.
        echo Когда закончишь и сохранишь .env — запусти start.bat ещё раз.
    ) else (
        echo [Ошибка] Не найден ни .env, ни .env.example рядом с этим файлом.
        echo Похоже, папка с приложением скопирована не полностью.
    )
    echo.
    pause
    exit /b 0
)

echo Запускаю приложение...
echo Чтобы остановить — закрой это окно или нажми Ctrl+C.
echo.
call npm start

echo.
echo ================================================
echo Приложение остановлено.
echo Если это произошло неожиданно — посмотри сообщения выше, там обычно
echo написано, что пошло не так.
echo ================================================
pause
