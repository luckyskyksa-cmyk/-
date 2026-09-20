const path = require('path');
const fs = require('fs');
const { db, DATA_DIR, dbPath } = require('./db');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// نسخة احتياطية آمنة باستخدام واجهة SQLite (تعمل حتى أثناء التشغيل)
function createBackup(reason = 'auto') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `lucky-sky-${reason}-${stamp}.db`);
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return file;
  } catch (err) {
    // بديل: نسخ الملف مباشرة
    fs.copyFileSync(dbPath, file);
    return file;
  }
}

function listBackups() {
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: st.size, created: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

// نسخة يومية تلقائية + تنظيف النسخ الأقدم من 60 يوماً (يبقى دائماً 30 نسخة على الأقل)
function autoDailyBackup() {
  const today = new Date().toISOString().slice(0, 10);
  const exists = fs
    .readdirSync(BACKUP_DIR)
    .some((f) => f.includes('daily') && f.includes(today));
  if (!exists) createBackup('daily');
  pruneOld();
}

function pruneOld() {
  const backups = listBackups();
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const keepMin = 30;
  backups.forEach((b, idx) => {
    if (idx < keepMin) return;
    if (new Date(b.created).getTime() < cutoff) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, b.file)); } catch (_) {}
    }
  });
}

function startAutoBackup() {
  autoDailyBackup();
  // فحص كل 6 ساعات لإنشاء نسخة اليوم إن لزم
  setInterval(autoDailyBackup, 6 * 60 * 60 * 1000).unref();
}

module.exports = { createBackup, listBackups, startAutoBackup, BACKUP_DIR };
