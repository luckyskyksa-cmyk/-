#!/usr/bin/env bash
# تشغيل لاكي سكاي على ماك / لينكس
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js غير مثبت. حمّله من https://nodejs.org (نسخة LTS) ثم أعد التشغيل."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "تثبيت مكونات البرنامج لأول مرة..."
  npm install
fi

echo "تشغيل البرنامج على http://localhost:3000 (كلمة المرور: luckysky)"
( sleep 2; (xdg-open http://localhost:3000 >/dev/null 2>&1 || open http://localhost:3000 >/dev/null 2>&1) ) &
npm start
