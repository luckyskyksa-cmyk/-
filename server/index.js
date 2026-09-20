const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { verifyPassword, issueToken } = require('./auth');
const apiRouter = require('./routes/api');
const { startAutoBackup } = require('./backup');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!verifyPassword(password)) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  const token = issueToken();
  res.cookie('ls_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ token });
});
app.post('/api/logout', (req, res) => { res.clearCookie('ls_token'); res.json({ ok: true }); });

app.use('/api', apiRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

// أي مسار غير معروف يرجع للتطبيق (SPA)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.includes('.')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`لاكي سكاي يعمل على المنفذ ${PORT}`);
  try { startAutoBackup(); } catch (e) { console.error('backup init error', e.message); }
});
