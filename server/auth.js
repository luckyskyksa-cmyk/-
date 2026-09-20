const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Internal-use app: a single shared access password protects the data.
// Configure via environment variables; sensible defaults for local/dev use.
const APP_PASSWORD = process.env.LUCKY_SKY_PASSWORD || 'luckysky';
const JWT_SECRET =
  process.env.LUCKY_SKY_SECRET ||
  'change-me-lucky-sky-internal-secret-please-set-env';
const TOKEN_TTL = '30d';

const passwordHash = bcrypt.hashSync(APP_PASSWORD, 10);

function verifyPassword(password) {
  if (typeof password !== 'string') return false;
  return bcrypt.compareSync(password, passwordHash);
}

function issueToken() {
  return jwt.sign({ role: 'user' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.cookies?.ls_token;
  if (!token) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول' });
  }
  try {
    jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'انتهت الجلسة، يرجى تسجيل الدخول من جديد' });
  }
}

module.exports = { verifyPassword, issueToken, requireAuth };
