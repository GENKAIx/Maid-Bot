@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist .env (
  copy .env.example .env >nul
  echo Создан файл .env — впишите в него ключи и запустите снова.
  notepad .env
  pause
  exit /b
)
if not exist web\dist call npm run build
npm run server
pause
