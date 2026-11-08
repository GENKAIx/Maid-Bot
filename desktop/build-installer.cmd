@echo off
rem Сборщик electron-builder не запускается из папки с русским именем — собираем через диск M:.
chcp 65001 >nul
subst M: "%~dp0.." 2>nul
pushd M:\desktop
call npx electron-builder --win nsis
popd
subst M: /d
echo Установщик: desktop\dist\Gornichnaya-Setup-*.exe
pause
