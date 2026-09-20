@echo off
chcp 65001 >nul
title لاكي سكاي - برنامج إدارة الديون
cd /d "%~dp0"

echo ============================================
echo        لاكي سكاي - تشغيل البرنامج
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ تنبيه ] برنامج Node.js غير مثبّت على الجهاز.
  echo.
  echo   1^) افتح الموقع: https://nodejs.org
  echo   2^) اضغط الزر الأخضر ^(LTS^) وثبّت البرنامج.
  echo   3^) ثم شغّل هذا الملف مرة أخرى.
  echo.
  pause
  exit /b
)

if not exist node_modules (
  echo تجهيز البرنامج لأول مرة... ^(يحتاج إنترنت، قد يأخذ دقيقة أو دقيقتين^)
  echo الرجاء الانتظار وعدم إغلاق النافذة...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ خطأ ] لم يكتمل التجهيز. تأكد من اتصال الإنترنت ثم أعد المحاولة.
    pause
    exit /b
  )
)

echo.
echo تم التشغيل بنجاح ^!
echo افتح المتصفح على العنوان:  http://localhost:3000
echo كلمة المرور:  luckysky
echo.
echo [ مهم ] اترك هذه النافذة السوداء مفتوحة أثناء استخدام البرنامج.
echo لإيقاف البرنامج: أغلق هذه النافذة.
echo.
start "" http://localhost:3000
call npm start
echo.
echo توقف البرنامج. اضغط أي زر للإغلاق.
pause >nul
