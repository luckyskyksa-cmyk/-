@echo off
chcp 65001 >nul
title لاكي سكاي - برنامج إدارة الديون
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js غير مثبت على الجهاز.
  echo     حمّله من الموقع الرسمي: https://nodejs.org  ^(اختر نسخة LTS^)
  echo     ثم شغّل هذا الملف مرة أخرى.
  echo.
  pause
  exit /b
)

if not exist node_modules (
  echo تثبيت مكونات البرنامج لأول مرة... قد يستغرق دقيقة.
  call npm install
)

echo.
echo تشغيل البرنامج... افتح المتصفح على http://localhost:3000
echo كلمة المرور الافتراضية: luckysky
echo لإيقاف البرنامج أغلق هذه النافذة.
echo.
start "" http://localhost:3000
call npm start
pause
