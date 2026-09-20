const { db } = require('./db');

const insert = db.prepare('INSERT INTO audit_log (action, entity, details) VALUES (?,?,?)');

function log(action, entity, details) {
  try { insert.run(action, entity || '', typeof details === 'string' ? details : JSON.stringify(details || {})); }
  catch (_) {}
}

function recent(limit = 200) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = { log, recent };
