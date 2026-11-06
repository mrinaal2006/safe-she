'use strict';
// Phone OTP: generation, rate limits, verification, and delivery through 2Factor.in.
// The 2Factor API key comes from the TWOFACTOR_API_KEY environment variable or, if that is not set, from the key the
// admin saved in Admin → Settings (stored in the database, so every deployment sharing the database uses it).
// Without a key the server runs in TEST MODE: codes are not sent by SMS; they are shown in the admin panel
// (and in the app only if OTP_SHOW_IN_APP=1).
const { sha256, digits, safeEqual } = require('./security');

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_GAP_MS = 30 * 1000;
const MAX_PER_PHONE_HOUR = 10;
const MAX_PER_IP_HOUR = 100;
const KEY_CACHE_MS = 30 * 1000;

const err = (status, message) => Object.assign(new Error(message), { status });
const mask = k => (k ? '••••' + k.slice(-4) : '');

function createOtpService(db, cfg, log) {
  const codeHash = (phone, role, code) => sha256(`${cfg.secret()}|${phone}|${role}|${code}`);

  // ---- where the 2Factor key comes from (env var first, then the admin-saved key), cached briefly
  let cache = null;
  async function keyInfo() {
    const envKey = (cfg.twoFactorKey || '').trim();
    if (envKey) return { key: envKey, source: 'env' };
    if (cache && Date.now() - cache.at < KEY_CACHE_MS) return cache.info;
    const r = await db.one("SELECT value FROM kv WHERE key = 'twofactor_key'");
    const info = r && r.value ? { key: r.value, source: 'admin' } : { key: '', source: 'none' };
    cache = { at: Date.now(), info };
    return info;
  }
  const isTestMode = async () => !(await keyInfo()).key;

  async function call2Factor(key, path) {
    const r = await fetch(`https://2factor.in/API/V1/${encodeURIComponent(key)}${path}`, { signal: AbortSignal.timeout(10000) });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok && body.Status === 'Success', status: r.status, body };
  }

  async function deliver(phone, code) {
    const { key } = await keyInfo();
    if (!key) {
      log(`[OTP TEST MODE] ${phone} → ${code}`);
      await db.exec('INSERT INTO otp_test_codes (phone, code, at) VALUES ($1,$2,$3)', [phone, code, Date.now()]);
      await db.exec('DELETE FROM otp_test_codes WHERE id NOT IN (SELECT id FROM otp_test_codes ORDER BY id DESC LIMIT 50)');
      return true;
    }
    // 2Factor.in "custom OTP" endpoint: we generate the code, 2Factor delivers it via its DLT-approved template.
    const num = phone.replace('+91', '');
    let path = `/SMS/${num}/${code}`;
    if (cfg.twoFactorTemplate) path += `/${encodeURIComponent(cfg.twoFactorTemplate)}`;
    const r = await call2Factor(key, path);
    if (!r.ok) {
      log(`[OTP] 2Factor send failed for ${phone}: HTTP ${r.status} ${r.body.Details || ''}`); // never log the key (it is in the URL)
      throw err(502, 'Could not send the OTP SMS. Please try again.');
    }
    return false;
  }

  async function send(phone, role, ip) {
    const now = Date.now();
    await db.exec('DELETE FROM otp_sends WHERE at < $1', [now - 3600_000]);
    const s = await db.one(`SELECT COUNT(*) FILTER (WHERE phone = $1) AS per_phone, COUNT(*) FILTER (WHERE ip = $2) AS per_ip
                            FROM otp_sends WHERE phone = $1 OR ip = $2`, [phone, ip]);
    const last = (await db.one('SELECT MAX(at) AS t FROM otp_sends WHERE phone = $1', [phone])).t;
    if (last && now - last < RESEND_GAP_MS) throw err(429, `Please wait ${Math.ceil((RESEND_GAP_MS - (now - last)) / 1000)} s before requesting another OTP.`);
    if (s.per_phone >= MAX_PER_PHONE_HOUR || s.per_ip >= MAX_PER_IP_HOUR) throw err(429, 'Too many OTP codes requested for this number. Please try again later.');

    const code = digits(6);
    const testMode = await deliver(phone, code);
    await db.exec(`INSERT INTO otps (phone, role, code_hash, expires_at, attempts) VALUES ($1,$2,$3,$4,0)
                   ON CONFLICT (phone, role) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0`,
      [phone, role, codeHash(phone, role, code), now + OTP_TTL_MS]);
    await db.exec('INSERT INTO otp_sends (phone, ip, at) VALUES ($1,$2,$3)', [phone, ip, now]);
    return { testMode, devCode: testMode ? code : undefined, expiresInSec: OTP_TTL_MS / 1000 };
  }

  async function verify(phone, role, code) {
    const row = await db.one('SELECT * FROM otps WHERE phone = $1 AND role = $2', [phone, role]);
    if (!row) throw err(400, 'Request an OTP first.');
    if (Date.now() > row.expires_at) {
      await db.exec('DELETE FROM otps WHERE phone = $1 AND role = $2', [phone, role]);
      throw err(400, 'OTP expired. Request a new one.');
    }
    if (row.attempts >= MAX_ATTEMPTS) throw err(429, 'Too many wrong attempts. Request a new OTP.');
    if (!/^\d{6}$/.test(String(code)) || !safeEqual(codeHash(phone, role, String(code)), row.code_hash)) {
      await db.exec('UPDATE otps SET attempts = attempts + 1 WHERE phone = $1 AND role = $2', [phone, role]);
      throw err(400, 'Wrong OTP. Please check and try again.');
    }
    // Single use: delete atomically so two parallel verifications cannot both succeed.
    const used = await db.exec('DELETE FROM otps WHERE phone = $1 AND role = $2 AND code_hash = $3', [phone, role, row.code_hash]);
    if (!used) throw err(400, 'OTP already used. Request a new one.');
    return true;
  }

  /** SMS account status for the admin panel (2Factor balance), without exposing the key. */
  // The 2Factor balance check takes a network round trip: remember the answer for a minute.
  let balCache = null;
  async function smsStatus(opts) {
    const { key, source } = await keyInfo();
    const base = { provider: '2Factor.in', source, keyHint: mask(key), configured: !!key };
    if (!key) return { ...base, message: 'No 2Factor API key yet, so login codes are NOT sent by SMS (test mode). Enter your key below.' };
    if (balCache && balCache.key === key && Date.now() - balCache.at < 60000) return { ...base, ...balCache.value };
    if (opts && opts.quick) return { ...base, pending: true, message: 'Checking SMS sending and balance…' };
    const value = await checkBalance(key);
    if (value.ok) balCache = { key, at: Date.now(), value };
    return { ...base, ...value };
  }
  async function checkBalance(key) {
    const base = {};
    try {
      const r = await call2Factor(key, '/BAL/SMS');
      if (r.ok) {
        const n = Number(r.body.Details), bal = Number.isFinite(n) ? String(Math.floor(n)) : String(r.body.Details);
        return { ...base, ok: true, balance: bal, message: 'SMS sending is active. Balance: ' + bal + ' SMS.' };
      }
      return { ...base, ok: false, message: '2Factor rejected the API key: ' + (r.body.Details || 'HTTP ' + r.status) + '. Check the key.' };
    } catch (e) {
      return { ...base, ok: false, message: 'Could not reach 2Factor.in: ' + e.message };
    }
  }

  /** Admin: save (after checking it with 2Factor) or remove the database-stored key. */
  async function saveKey(newKey) {
    const k = String(newKey || '').trim();
    if (!k) {
      await db.exec("DELETE FROM kv WHERE key = 'twofactor_key'");
      cache = null; balCache = null;
      return smsStatus();
    }
    if (!/^[A-Za-z0-9-]{16,64}$/.test(k)) throw err(400, 'That does not look like a 2Factor API key (letters, numbers and dashes, e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).');
    let r;
    try { r = await call2Factor(k, '/BAL/SMS'); } catch (e) { throw err(502, 'Could not reach 2Factor.in to check the key: ' + e.message); }
    if (!r.ok) throw err(400, '2Factor did not accept this key: ' + (r.body.Details || 'HTTP ' + r.status) + '. Copy it again from 2Factor → Account Summary.');
    await db.exec("INSERT INTO kv (key, value) VALUES ('twofactor_key', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k]);
    cache = null;
    log('[admin] 2Factor API key saved (' + mask(k) + ')');
    return smsStatus();
  }

  /** Admin: send a one-off test SMS to check delivery (not a login code). */
  async function sendTest(phone) {
    if (await isTestMode()) throw err(400, 'Save your 2Factor API key first. Test mode does not send SMS.');
    await deliver(phone, digits(6));
  }

  async function recentTestCodes() {
    return (await isTestMode()) ? db.q('SELECT phone, code, at FROM otp_test_codes ORDER BY id DESC LIMIT 20') : [];
  }

  return { send, verify, isTestMode, recentTestCodes, smsStatus, sendTest, saveKey, keyInfo };
}

module.exports = { createOtpService };
