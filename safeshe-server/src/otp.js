'use strict';
// Phone OTP: generation, rate limits, verification, and delivery through 2Factor.in.
// Without TWOFACTOR_API_KEY the server runs in TEST MODE: codes are not sent by SMS; they are
// logged and shown in the admin panel (and in the app only if OTP_SHOW_IN_APP=1).
const { sha256, digits, safeEqual } = require('./security');

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_GAP_MS = 30 * 1000;
const MAX_PER_PHONE_HOUR = 10;
const MAX_PER_IP_HOUR = 100;

const err = (status, message) => Object.assign(new Error(message), { status });

function createOtpService(db, cfg, log) {
  const testMode = !cfg.twoFactorKey;
  const codeHash = (phone, role, code) => sha256(`${cfg.secret()}|${phone}|${role}|${code}`);

  async function deliver(phone, code) {
    if (testMode) {
      log(`[OTP TEST MODE] ${phone} → ${code}`);
      await db.exec('INSERT INTO otp_test_codes (phone, code, at) VALUES ($1,$2,$3)', [phone, code, Date.now()]);
      await db.exec('DELETE FROM otp_test_codes WHERE id NOT IN (SELECT id FROM otp_test_codes ORDER BY id DESC LIMIT 50)');
      return;
    }
    // 2Factor.in "custom OTP" endpoint: we generate the code, 2Factor delivers it via its DLT-approved template.
    const num = phone.replace('+91', '');
    let url = `https://2factor.in/API/V1/${encodeURIComponent(cfg.twoFactorKey)}/SMS/${num}/${code}`;
    if (cfg.twoFactorTemplate) url += `/${encodeURIComponent(cfg.twoFactorTemplate)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.Status !== 'Success') {
      log(`[OTP] 2Factor send failed for ${phone}: HTTP ${r.status} ${body.Details || ''}`); // never log the key (it is in the URL)
      throw err(502, 'Could not send the OTP SMS. Please try again.');
    }
  }

  async function send(phone, role, ip) {
    const now = Date.now();
    await db.exec('DELETE FROM otp_sends WHERE at < $1', [now - 3600_000]);
    const s = await db.one(`SELECT MAX(at) AS last, COUNT(*) FILTER (WHERE phone = $1) AS per_phone, COUNT(*) FILTER (WHERE ip = $2) AS per_ip
                            FROM otp_sends WHERE phone = $1 OR ip = $2`, [phone, ip]);
    const last = (await db.one('SELECT MAX(at) AS t FROM otp_sends WHERE phone = $1', [phone])).t;
    if (last && now - last < RESEND_GAP_MS) throw err(429, `Please wait ${Math.ceil((RESEND_GAP_MS - (now - last)) / 1000)} s before requesting another OTP.`);
    if (s.per_phone >= MAX_PER_PHONE_HOUR || s.per_ip >= MAX_PER_IP_HOUR) throw err(429, 'Too many OTP codes requested for this number. Please try again later.');

    const code = digits(6);
    await deliver(phone, code);
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
  async function smsStatus() {
    if (testMode) return { provider: '2Factor.in', configured: false, message: 'TWOFACTOR_API_KEY is not set, so login codes are NOT sent by SMS (test mode).' };
    try {
      const r = await fetch(`https://2factor.in/API/V1/${encodeURIComponent(cfg.twoFactorKey)}/BAL/SMS`, { signal: AbortSignal.timeout(10000) });
      const body = await r.json().catch(() => ({}));
      if (body.Status === 'Success') return { provider: '2Factor.in', configured: true, ok: true, balance: body.Details, message: 'SMS sending is active. Balance: ' + body.Details + ' SMS.' };
      return { provider: '2Factor.in', configured: true, ok: false, message: '2Factor rejected the API key: ' + (body.Details || 'HTTP ' + r.status) + '. Check TWOFACTOR_API_KEY.' };
    } catch (e) {
      return { provider: '2Factor.in', configured: true, ok: false, message: 'Could not reach 2Factor.in: ' + e.message };
    }
  }

  /** Admin: send a one-off test SMS to check delivery (not a login code). */
  async function sendTest(phone) {
    if (testMode) throw err(400, 'Set TWOFACTOR_API_KEY first. Test mode does not send SMS.');
    await deliver(phone, digits(6));
  }

  async function recentTestCodes() {
    return testMode ? db.q('SELECT phone, code, at FROM otp_test_codes ORDER BY id DESC LIMIT 20') : [];
  }

  return { send, verify, testMode, recentTestCodes, smsStatus, sendTest };
}

module.exports = { createOtpService };
