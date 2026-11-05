'use strict';
const crypto = require('node:crypto');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function token(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function digits(n) { let s = ''; for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10); return s; }

// scrypt password hashing: "scrypt$<salt>$<hash>"
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const h = crypto.scryptSync(pw, salt, 64).toString('base64url');
  return `scrypt$${salt}$${h}`;
}
function verifyPassword(pw, stored) {
  const [alg, salt, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const a = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(h, 'base64url');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Indian mobile numbers only: returns "+91XXXXXXXXXX" or null. */
function normalizePhone(input) {
  let d = String(input || '').replace(/[^\d]/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return null;
  return '+91' + d;
}

module.exports = { sha256, token, digits, hashPassword, verifyPassword, safeEqual, normalizePhone };
