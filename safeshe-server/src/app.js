'use strict';
/*
 * SafeShe Rides API (Express + PostgreSQL). Runs on Vercel (serverless, see api/index.js) or as a normal
 * Node server (src/server.js). No long-lived connections: live updates are stored in the `events` table
 * and clients poll GET /api/events every ~2 s. Ride matching ("dispatch") runs on those polls, at most
 * once every few seconds across all instances.
 */
const path = require('node:path');
const express = require('express');
const { createDb } = require('./db');
const sec = require('./security');
const { createOtpService } = require('./otp');
const { createGeo, haversineKm } = require('./geo');

const ACTIVE = ['requested', 'accepted', 'arrived', 'started'];
const VEHICLES = ['bike', 'auto', 'cab', 'pink'];
const TICK_MS = 3000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function loadConfig(env = process.env) {
  return {
    env,
    adminUser: env.ADMIN_USERNAME || 'Administrator',
    adminPassword: env.ADMIN_PASSWORD || '',
    adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminReset: env.ADMIN_RESET_PASSWORD === '1',
    twoFactorKey: env.TWOFACTOR_API_KEY || '',
    twoFactorTemplate: env.TWOFACTOR_TEMPLATE || '',
    showTestOtpInApp: env.OTP_SHOW_IN_APP === '1',
    publicUrl: (env.PUBLIC_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + env.VERCEL_PROJECT_PRODUCTION_URL : '')).replace(/\/$/, ''),
    contactEmail: env.CONTACT_EMAIL || (env.ADMIN_EMAIL || '').trim(),
    nominatimUrl: env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    photonUrl: env.PHOTON_URL || 'https://photon.komoot.io',
    osrmUrl: env.OSRM_URL || 'https://router.project-osrm.org',
    radiusKm: +env.DISPATCH_RADIUS_KM || 6,
    searchMs: (+env.SEARCH_TIMEOUT_SEC || 120) * 1000,
    appDir: env.APP_DIR ? path.resolve(env.APP_DIR) : null,
    quiet: env.QUIET === '1',
  };
}

function createApp(cfg) {
  const log = (...a) => { if (!cfg.quiet) console.log(new Date().toISOString(), ...a); };
  const db = createDb(cfg.env);
  let secret = null;
  cfg.secret = () => secret;
  const otp = createOtpService(db, cfg, log);
  const geo = createGeo(cfg, log);

  // ---------------------------------------------------------------- one-time init per instance
  let initP = null;
  function init() {
    if (!initP) initP = (async () => {
      await db.ready();
      secret = cfg.env.SECRET || null;
      if (!secret) {
        await db.exec("INSERT INTO kv (key, value) VALUES ('secret', $1) ON CONFLICT (key) DO NOTHING", [sec.token(48)]);
        secret = (await db.one("SELECT value FROM kv WHERE key = 'secret'")).value;
      }
      if (cfg.adminPassword) {
        const ex = await db.one('SELECT id FROM admins WHERE username = $1', [cfg.adminUser]);
        if (!ex) {
          await db.exec('INSERT INTO admins (username, pass_hash, created_at) VALUES ($1,$2,$3) ON CONFLICT (username) DO NOTHING', [cfg.adminUser, sec.hashPassword(cfg.adminPassword), Date.now()]);
          log(`[admin] created admin user "${cfg.adminUser}"`);
        } else if (cfg.adminReset) {
          await db.exec('UPDATE admins SET pass_hash = $1 WHERE id = $2', [sec.hashPassword(cfg.adminPassword), ex.id]);
          log(`[admin] password reset for "${cfg.adminUser}"`);
        }
        // ADMIN_EMAIL (optional) lets the admin log in with email instead of the username.
        // It is applied when no email is set yet (or with ADMIN_RESET_PASSWORD=1); later changes happen in Admin → Settings.
        if (cfg.adminEmail) {
          if (!EMAIL_RE.test(cfg.adminEmail)) log(`[admin] WARNING: ADMIN_EMAIL "${cfg.adminEmail}" is not a valid email; ignored.`);
          else await db.exec('UPDATE admins SET email = $1 WHERE username = $2 AND (email IS NULL OR $3)', [cfg.adminEmail, cfg.adminUser, cfg.adminReset]);
        }
      } else if (!(await db.one('SELECT COUNT(*) AS n FROM admins')).n) {
        log('[admin] WARNING: no admin account. Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME) and redeploy.');
      }
      if (otp.testMode) log('[otp] TEST MODE: no TWOFACTOR_API_KEY set, so OTPs are not sent by SMS (see admin panel → Settings).');
      // Default commission (once): ₹5 bike, ₹6 auto, ₹8 cab / pink cab per completed ride. Editable in Admin → Fares.
      if (await db.exec("INSERT INTO kv (key, value) VALUES ('commission_seeded', '1') ON CONFLICT (key) DO NOTHING"))
        await db.exec("UPDATE fares SET commission_type = 'flat', commission_value = CASE vehicle WHEN 'bike' THEN 5 WHEN 'auto' THEN 6 ELSE 8 END WHERE commission_value = 0");
    })().catch(e => { initP = null; throw e; });
    return initP;
  }

  // ---------------------------------------------------------------- helpers
  const now = () => Date.now();
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const num = (v, lo, hi) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const point = o => { const lat = num(o && o.lat, -90, 90), lng = num(o && o.lng, -180, 180); return lat == null || lng == null ? null : { lat, lng }; };

  async function rateLimit(key, max, windowMs) {
    const t = now();
    const r = await db.one(`INSERT INTO rate_limits (key, n, reset_at) VALUES ($1, 1, $2)
      ON CONFLICT (key) DO UPDATE SET
        n = CASE WHEN rate_limits.reset_at < $3 THEN 1 ELSE rate_limits.n + 1 END,
        reset_at = CASE WHEN rate_limits.reset_at < $3 THEN $2 ELSE rate_limits.reset_at END
      RETURNING n`, [key, t + windowMs, t]);
    if (r.n > max) throw httpError(429, 'Too many requests. Please slow down.');
  }

  async function emit(target, type, data) {
    await db.exec('INSERT INTO events (target, type, data, created_at) VALUES ($1,$2,$3,$4)', [target, type, JSON.stringify(data || {}), now()]);
  }

  async function issueSession(kind, id) {
    const t = sec.token();
    const ttl = kind === 'admin' ? 12 * 3600_000 : 90 * 24 * 3600_000;
    await db.exec('INSERT INTO sessions (token_hash, kind, subject_id, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)', [sec.sha256(t), kind, id, now(), now() + ttl]);
    return t;
  }
  async function sessionFrom(tokenStr) {
    if (!tokenStr) return null;
    const s = await db.one('SELECT * FROM sessions WHERE token_hash = $1', [sec.sha256(tokenStr)]);
    if (!s || s.expires_at < now()) return null;
    if (s.kind === 'admin') {
      const a = await db.one('SELECT id, username FROM admins WHERE id = $1', [s.subject_id]);
      return a ? { kind: 'admin', admin: a } : null;
    }
    const u = await db.one('SELECT * FROM users WHERE id = $1', [s.subject_id]);
    if (!u || u.blocked) return null;
    return { kind: 'user', user: u };
  }
  const bearer = req => { const h = req.get('authorization') || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
  const auth = role => wrap(async (req, res, next) => {
    const s = await sessionFrom(bearer(req));
    if (!s) throw httpError(401, 'Please log in again.');
    if (role === 'admin' && s.kind !== 'admin') throw httpError(403, 'Admin only.');
    if (role === 'any') { /* user or admin */ }
    else if (role && role !== 'admin' && (s.kind !== 'user' || s.user.role !== role)) throw httpError(403, 'Not allowed for this account.');
    else if (!role && s.kind !== 'user') throw httpError(403, 'User account required.');
    req.s = s; req.user = s.user; next();
  });

  const driverRow = userId => db.one('SELECT * FROM drivers WHERE user_id = $1', [userId]);
  const getUser = id => db.one('SELECT * FROM users WHERE id = $1', [id]);
  async function publicUser(u) {
    if (!u) return null;
    const out = { id: u.id, phone: u.phone, role: u.role, name: u.name, gender: u.gender, emergencyPhone: u.emergency_phone, createdAt: u.created_at };
    if (u.role === 'driver') {
      const d = await driverRow(u.id);
      out.driver = d ? { vehicleType: d.vehicle_type, vehicleModel: d.vehicle_model, plate: d.plate, licenseNo: d.license_no, status: d.status, online: d.online,
        rating: d.rating_count ? +(d.rating_sum / d.rating_count).toFixed(2) : null, ratingCount: d.rating_count } : null;
    }
    return out;
  }
  const fares = () => db.q('SELECT * FROM fares ORDER BY sort');

  // ---------------- commission (platform fee) owed by riders to the admin
  const round2 = n => Math.round(n * 100) / 100;
  const commissionFor = (f, fare) => !f ? 0 : round2(Math.max(0, f.commission_type === 'percent' ? fare * f.commission_value / 100 : f.commission_value));
  const UPI_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/;
  async function paymentSettings() {
    const rows = await db.q("SELECT key, value FROM kv WHERE key IN ('pay_upi', 'pay_name', 'pay_limit')");
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return { upiId: m.pay_upi || '', payeeName: m.pay_name || 'SafeShe', duesLimit: +m.pay_limit || 0 };
  }
  async function duesFor(driverId) {
    const r = await db.one(`SELECT
      (SELECT COALESCE(SUM(commission), 0) FROM rides WHERE driver_id = $1 AND status = 'completed') AS charged,
      (SELECT COALESCE(SUM(amount), 0) FROM commission_payments WHERE driver_id = $1 AND status = 'confirmed') AS paid,
      (SELECT COALESCE(SUM(amount), 0) FROM commission_payments WHERE driver_id = $1 AND status = 'pending') AS pending`, [driverId]);
    const due = round2(Math.max(0, r.charged - r.paid));
    return { charged: round2(r.charged), paid: round2(r.paid), pending: round2(r.pending), due, toPay: round2(Math.max(0, due - r.pending)) };
  }
  const fareFor = (f, km, min) => Math.round(Math.max(f.min_fare, f.base + f.per_km * km + f.per_min * min));
  const shareUrl = token => (cfg.publicUrl || '') + '/t/' + token;

  const RIDE_SELECT = `SELECT r.*, p.name AS p_name, p.phone AS p_phone,
      du.name AS d_name, du.phone AS d_phone, du.gender AS d_gender,
      d.vehicle_type AS d_vtype, d.vehicle_model AS d_model, d.plate AS d_plate, d.rating_sum AS d_rsum, d.rating_count AS d_rcount,
      d.lat AS d_lat, d.lng AS d_lng, d.loc_at AS d_loc_at
    FROM rides r JOIN users p ON p.id = r.passenger_id LEFT JOIN users du ON du.id = r.driver_id LEFT JOIN drivers d ON d.user_id = r.driver_id`;
  const getRide = id => db.one(RIDE_SELECT + ' WHERE r.id = $1', [id]);
  const activeRideFor = (userId, asRole) => db.one(RIDE_SELECT + ` WHERE ${asRole === 'driver' ? 'r.driver_id' : 'r.passenger_id'} = $1 AND r.status = ANY($2) ORDER BY r.id DESC LIMIT 1`, [userId, ACTIVE]);

  /** Ride as seen by `viewer` ('passenger' | 'driver' | 'admin' | 'track'). */
  function rideView(r, viewer) {
    if (!r) return null;
    const active = ACTIVE.includes(r.status), showPhone = active || viewer === 'admin';
    const out = {
      id: r.id, status: r.status, vehicle: r.vehicle, payment: r.payment, fare: r.fare,
      pickup: { lat: r.pickup_lat, lng: r.pickup_lng, name: r.pickup_name },
      drop: { lat: r.drop_lat, lng: r.drop_lng, name: r.drop_name },
      distanceKm: +r.distance_km.toFixed(2), durationMin: Math.round(r.duration_min), routeApprox: r.route_approx,
      requestedAt: r.requested_at, acceptedAt: r.accepted_at, arrivedAt: r.arrived_at, startedAt: r.started_at,
      completedAt: r.completed_at, cancelledAt: r.cancelled_at, cancelledBy: r.cancelled_by, cancelReason: r.cancel_reason, rating: r.rating,
      passenger: { id: r.passenger_id, name: r.p_name, phone: showPhone ? r.p_phone : undefined },
      driver: r.driver_id ? {
        id: r.driver_id, name: r.d_name, gender: r.d_gender, phone: showPhone ? r.d_phone : undefined,
        vehicleType: r.d_vtype, vehicleModel: r.d_model, plate: r.d_plate,
        rating: r.d_rcount ? +(r.d_rsum / r.d_rcount).toFixed(1) : null, lat: r.d_lat, lng: r.d_lng, locAt: r.d_loc_at,
      } : null,
    };
    if (viewer === 'passenger' || viewer === 'admin') { out.otp = r.otp; out.shareUrl = shareUrl(r.share_token); out.shareToken = r.share_token; }
    if (viewer === 'driver' || viewer === 'admin') out.commission = r.commission || 0;
    return out;
  }

  async function pushRide(id) {
    const r = await getRide(id); if (!r) return;
    await emit('user:' + r.passenger_id, 'ride:update', rideView(r, 'passenger'));
    if (r.driver_id) await emit('user:' + r.driver_id, 'ride:update', rideView(r, 'driver'));
    await emit('admins', 'admin:ride', { id: r.id, status: r.status });
  }
  async function updateDriverLocation(userId, p) {
    await db.exec('UPDATE drivers SET lat = $1, lng = $2, loc_at = $3 WHERE user_id = $4', [p.lat, p.lng, now(), userId]);
    const r = await db.one("SELECT id, passenger_id FROM rides WHERE driver_id = $1 AND status IN ('accepted','arrived','started') LIMIT 1", [userId]);
    if (r) await emit('user:' + r.passenger_id, 'ride:driver_location', { rideId: r.id, lat: p.lat, lng: p.lng, at: now() });
  }

  // ---------------------------------------------------------------- dispatch (ride matching)
  function availableDrivers() {
    return db.q(`SELECT d.*, u.gender, u.name FROM drivers d JOIN users u ON u.id = d.user_id
      WHERE d.status = 'approved' AND d.online AND NOT u.blocked AND d.loc_at > $1
      AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = d.user_id AND r.status IN ('accepted','arrived','started'))`, [now() - 120_000]);
  }
  function matches(d, vehicle) {
    if (vehicle === 'pink') return d.vehicle_type === 'cab' && d.gender === 'female';
    return d.vehicle_type === vehicle;
  }
  function offerView(r, d) {
    return { rideId: r.id, vehicle: r.vehicle, fare: r.fare, payment: r.payment, distanceKm: +r.distance_km.toFixed(1), durationMin: Math.round(r.duration_min),
      pickup: { lat: r.pickup_lat, lng: r.pickup_lng, name: r.pickup_name }, drop: { lat: r.drop_lat, lng: r.drop_lng, name: r.drop_name },
      pickupKm: d && d.lat != null ? +haversineKm({ lat: r.pickup_lat, lng: r.pickup_lng }, d).toFixed(1) : null,
      expiresAt: r.requested_at + cfg.searchMs };
  }
  async function dispatch(r, drivers) {
    if (!r || r.status !== 'requested') return;
    const pick = { lat: r.pickup_lat, lng: r.pickup_lng };
    const cands = (drivers || await availableDrivers()).filter(d => matches(d, r.vehicle) && haversineKm(pick, d) <= cfg.radiusKm)
      .sort((a, b) => haversineKm(pick, a) - haversineKm(pick, b));
    for (const d of cands) {
      const ins = await db.exec('INSERT INTO ride_offers (ride_id, driver_id, offered_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [r.id, d.user_id, now()]);
      if (ins) await emit('user:' + d.user_id, 'ride:offer', offerView(r, d));
    }
  }
  async function closeOffers(rideId) {
    for (const o of await db.q('SELECT driver_id FROM ride_offers WHERE ride_id = $1', [rideId])) await emit('user:' + o.driver_id, 'ride:offer_closed', { rideId });
  }
  async function openOffersFor(driverId) {
    const d = await driverRow(driverId);
    const rows = await db.q("SELECT r.* FROM ride_offers o JOIN rides r ON r.id = o.ride_id WHERE o.driver_id = $1 AND NOT o.declined AND r.status = 'requested'", [driverId]);
    return rows.map(r => offerView(r, d));
  }
  /** Periodic work without a background process: runs at most once per TICK_MS across all instances. */
  async function tick(force) {
    const t = now();
    const won = await db.exec("UPDATE kv SET value = $1 WHERE key = 'last_tick' AND (value::bigint < $2 OR $3)", [String(t), t - TICK_MS, !!force]);
    if (!won) return;
    const open = await db.q("SELECT * FROM rides WHERE status = 'requested'");
    const drivers = open.length ? await availableDrivers() : [];
    for (const r of open) {
      if (t - r.requested_at > cfg.searchMs) {
        const ch = await db.exec("UPDATE rides SET status = 'no_driver', cancelled_at = $1, cancelled_by = 'system', cancel_reason = 'No rider accepted in time' WHERE id = $2 AND status = 'requested'", [t, r.id]);
        if (ch) { await closeOffers(r.id); await pushRide(r.id); log(`[ride ${r.id}] no rider found`); }
      } else await dispatch(r, drivers);
    }
    if (Math.random() < 0.05) { // light housekeeping
      await db.exec('DELETE FROM events WHERE created_at < $1', [t - 3600_000]);
      await db.exec('DELETE FROM sessions WHERE expires_at < $1', [t]);
      await db.exec('DELETE FROM rate_limits WHERE reset_at < $1', [t]);
    }
  }

  // ---------------------------------------------------------------- express
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) {
      // Bearer-token API (no cookies), so any origin is safe, including the Android app's file:// page.
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.set('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', wrap(async (req, res, next) => { await init(); next(); }));
  const ip = req => req.ip || 'unknown';

  app.get('/api/health', wrap(async (req, res) => { await db.one('SELECT 1 AS ok'); res.json({ ok: true, otpTestMode: otp.testMode, time: now() }); }));

  // ---------------- auth
  app.post('/api/auth/otp/send', wrap(async (req, res) => {
    const phone = sec.normalizePhone(req.body.phone), role = req.body.role;
    if (!phone) throw httpError(400, 'Enter a valid 10-digit Indian mobile number.');
    if (!['passenger', 'driver'].includes(role)) throw httpError(400, 'Invalid account type.');
    const u = await db.one('SELECT blocked FROM users WHERE phone = $1 AND role = $2', [phone, role]);
    if (u && u.blocked) throw httpError(403, 'This account is blocked. Contact SafeShe support.');
    const r = await otp.send(phone, role, ip(req));
    res.json({ ok: true, phone, testMode: r.testMode, devCode: cfg.showTestOtpInApp ? r.devCode : undefined, expiresInSec: r.expiresInSec });
  }));
  app.post('/api/auth/otp/verify', wrap(async (req, res) => {
    const phone = sec.normalizePhone(req.body.phone), role = req.body.role;
    if (!phone || !['passenger', 'driver'].includes(role)) throw httpError(400, 'Invalid request.');
    await otp.verify(phone, role, str(req.body.code, 10));
    let u = await db.one('SELECT * FROM users WHERE phone = $1 AND role = $2', [phone, role]);
    if (!u) {
      u = await db.one('INSERT INTO users (phone, role, created_at) VALUES ($1,$2,$3) ON CONFLICT (phone, role) DO UPDATE SET phone = EXCLUDED.phone RETURNING *', [phone, role, now()]);
      log(`[auth] new ${role} ${phone}`);
    }
    if (u.blocked) throw httpError(403, 'This account is blocked. Contact SafeShe support.');
    res.json({ token: await issueSession('user', u.id), user: await publicUser(u) });
  }));
  app.post('/api/admin/login', wrap(async (req, res) => {
    // Only WRONG passwords are counted (30 per 15 minutes per IP) to stop password guessing; correct logins are never limited.
    const failKey = 'adminfail:' + ip(req);
    const fails = await db.one('SELECT n FROM rate_limits WHERE key = $1 AND reset_at > $2', [failKey, now()]);
    if (fails && fails.n >= 30) throw httpError(429, 'Too many wrong passwords. Please wait 15 minutes and try again.');
    // Log in with the username or the admin email.
    const id = str(req.body.username, 200);
    const a = await db.one('SELECT * FROM admins WHERE username = $1 OR (email IS NOT NULL AND LOWER(email) = LOWER($1)) LIMIT 1', [id]);
    if (!a || !sec.verifyPassword(String(req.body.password || ''), a.pass_hash)) {
      log(`[admin] failed login from ${ip(req)}`);
      await rateLimit(failKey, 1e9, 15 * 60_000); // count the failure only
      throw httpError(401, 'Wrong username/email or password.');
    }
    await db.exec('DELETE FROM rate_limits WHERE key = $1', [failKey]);
    res.json({ token: await issueSession('admin', a.id), admin: { id: a.id, username: a.username, email: a.email } });
  }));
  app.post('/api/logout', wrap(async (req, res) => {
    const t = bearer(req); if (t) await db.exec('DELETE FROM sessions WHERE token_hash = $1', [sec.sha256(t)]);
    res.json({ ok: true });
  }));

  // ---------------- live events (polling)
  app.get('/api/events', auth('any'), wrap(async (req, res) => {
    const target = req.s.kind === 'admin' ? 'admins' : 'user:' + req.user.id;
    await tick().catch(e => log('[tick]', e.message));
    const after = num(req.query.after, 0, Number.MAX_SAFE_INTEGER);
    if (after == null) { // first poll: start from "now", no backlog
      const r = await db.one('SELECT COALESCE(MAX(id), 0) AS id FROM events');
      return res.json({ cursor: r.id, events: [] });
    }
    const rows = await db.q('SELECT id, type, data FROM events WHERE target = $1 AND id > $2 ORDER BY id LIMIT 100', [target, after]);
    const cursor = rows.length ? rows[rows.length - 1].id : after;
    res.json({ cursor, events: rows.map(e => ({ type: e.type, data: e.data })) });
  }));

  // ---------------- profile
  app.get('/api/me', auth(), wrap(async (req, res) => {
    res.json({ user: await publicUser(req.user), activeRide: rideView(await activeRideFor(req.user.id, req.user.role), req.user.role) });
  }));
  app.put('/api/me', auth(), wrap(async (req, res) => {
    const name = str(req.body.name, 60);
    if (name.length < 2) throw httpError(400, 'Please enter your name.');
    const gender = ['female', 'male', 'other', ''].includes(req.body.gender) ? req.body.gender : '';
    let ep = str(req.body.emergencyPhone, 20);
    if (ep) { ep = sec.normalizePhone(ep); if (!ep) throw httpError(400, 'Emergency contact must be a valid Indian mobile number.'); }
    await db.exec('UPDATE users SET name = $1, gender = $2, emergency_phone = $3 WHERE id = $4', [name, gender, ep || '', req.user.id]);
    res.json({ user: await publicUser(await getUser(req.user.id)) });
  }));
  app.post('/api/driver/profile', auth('driver'), wrap(async (req, res) => {
    const vt = req.body.vehicleType;
    if (!['bike', 'auto', 'cab'].includes(vt)) throw httpError(400, 'Choose your vehicle type.');
    const model = str(req.body.vehicleModel, 60), plate = str(req.body.plate, 20).toUpperCase(), lic = str(req.body.licenseNo, 30).toUpperCase();
    if (model.length < 2) throw httpError(400, 'Enter your vehicle model.');
    if (!/^[A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{0,3}[ -]?\d{1,4}$/.test(plate)) throw httpError(400, 'Enter a valid number plate, e.g. KA 01 AB 1234.');
    if (lic.length < 6) throw httpError(400, 'Enter your driving licence number.');
    const ex = await driverRow(req.user.id);
    if (ex) {
      // Changing vehicle details sends the rider back for approval.
      const changed = ex.vehicle_type !== vt || ex.plate !== plate || ex.license_no !== lic || ex.vehicle_model !== model;
      await db.exec('UPDATE drivers SET vehicle_type=$1, vehicle_model=$2, plate=$3, license_no=$4, status=$5, online = CASE WHEN $6 THEN FALSE ELSE online END, updated_at=$7 WHERE user_id=$8',
        [vt, model, plate, lic, changed ? 'pending' : ex.status, changed, now(), req.user.id]);
      if (changed) await emit('admins', 'admin:driver_pending', { id: req.user.id });
    } else {
      await db.exec('INSERT INTO drivers (user_id, vehicle_type, vehicle_model, plate, license_no, status, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [req.user.id, vt, model, plate, lic, 'pending', now()]);
      await emit('admins', 'admin:driver_pending', { id: req.user.id });
    }
    res.json({ user: await publicUser(await getUser(req.user.id)) });
  }));

  // ---------------- geo
  app.get('/api/geo/search', auth(), wrap(async (req, res) => {
    const near = req.query.lat ? point({ lat: req.query.lat, lng: req.query.lng }) : null;
    res.json({ results: await geo.search(req.query.q, near) });
  }));
  app.get('/api/geo/reverse', auth(), wrap(async (req, res) => {
    const p = point(req.query); if (!p) throw httpError(400, 'Invalid location.');
    res.json(await geo.reverse(p.lat, p.lng));
  }));

  // ---------------- rides: passenger
  app.post('/api/rides/quote', auth('passenger'), wrap(async (req, res) => {
    const a = point(req.body.pickup), b = point(req.body.drop);
    if (!a || !b) throw httpError(400, 'Choose pickup and drop locations.');
    if (haversineKm(a, b) < 0.1) throw httpError(400, 'Pickup and drop are too close.');
    if (haversineKm(a, b) > 150) throw httpError(400, 'Rides are limited to 150 km.');
    const [rt, online, fs] = await Promise.all([geo.route(a, b), availableDrivers(), fares()]);
    const opts = fs.filter(f => f.active).map(f => {
      const near = online.filter(d => matches(d, f.vehicle) && haversineKm(a, d) <= cfg.radiusKm);
      const eta = near.length ? Math.max(1, Math.round(Math.min(...near.map(d => haversineKm(a, d))) / 18 * 60)) : null;
      return { vehicle: f.vehicle, name: f.name, fare: fareFor(f, rt.km, rt.min), etaMin: eta, ridersNearby: near.length };
    });
    res.json({ km: +rt.km.toFixed(2), min: Math.round(rt.min), approx: rt.approx, points: rt.points, options: opts });
  }));
  app.post('/api/rides', auth('passenger'), wrap(async (req, res) => {
    const u = req.user;
    if (!u.name) throw httpError(400, 'Complete your profile first.');
    if (await activeRideFor(u.id, 'passenger')) throw httpError(409, 'You already have an active ride.');
    const a = point(req.body.pickup), b = point(req.body.drop), vehicle = req.body.vehicle;
    if (!a || !b) throw httpError(400, 'Choose pickup and drop locations.');
    const f = (await fares()).find(x => x.vehicle === vehicle && x.active);
    if (!f) throw httpError(400, 'This ride type is not available.');
    const payment = req.body.payment === 'upi' ? 'upi' : 'cash';
    const rt = await geo.route(a, b);
    const row = await db.one(`INSERT INTO rides (passenger_id, vehicle, status, pickup_lat, pickup_lng, pickup_name, drop_lat, drop_lng, drop_name,
        distance_km, duration_min, route_approx, fare, payment, otp, share_token, requested_at)
      VALUES ($1,$2,'requested',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [u.id, vehicle, a.lat, a.lng, str(req.body.pickup.name, 200) || 'Pickup point', b.lat, b.lng, str(req.body.drop.name, 200) || 'Drop point',
        rt.km, rt.min, rt.approx, fareFor(f, rt.km, rt.min), payment, sec.digits(4), sec.token(12), now()]);
    log(`[ride ${row.id}] requested by user ${u.id} (${vehicle})`);
    await dispatch(await db.one('SELECT * FROM rides WHERE id = $1', [row.id]));
    await pushRide(row.id);
    res.json({ ride: rideView(await getRide(row.id), 'passenger'), route: rt.points });
  }));
  app.get('/api/rides/active', auth(), wrap(async (req, res) => res.json({ ride: rideView(await activeRideFor(req.user.id, req.user.role), req.user.role) })));
  app.get('/api/rides/history', auth(), wrap(async (req, res) => {
    const col = req.user.role === 'driver' ? 'r.driver_id' : 'r.passenger_id';
    const rows = await db.q(RIDE_SELECT + ` WHERE ${col} = $1 ORDER BY r.id DESC LIMIT 50`, [req.user.id]);
    res.json({ rides: rows.map(r => rideView(r, req.user.role)) });
  }));
  app.get('/api/rides/:id', auth(), wrap(async (req, res) => {
    const r = await getRide(+req.params.id || 0);
    if (!r || (r.passenger_id !== req.user.id && r.driver_id !== req.user.id)) throw httpError(404, 'Ride not found.');
    res.json({ ride: rideView(r, req.user.role) });
  }));
  app.post('/api/rides/:id/cancel', auth(), wrap(async (req, res) => {
    const r = await getRide(+req.params.id || 0), u = req.user;
    if (!r || (r.passenger_id !== u.id && r.driver_id !== u.id)) throw httpError(404, 'Ride not found.');
    const by = u.role === 'driver' ? 'driver' : 'passenger';
    const ch = await db.exec("UPDATE rides SET status = 'cancelled', cancelled_at = $1, cancelled_by = $2, cancel_reason = $3 WHERE id = $4 AND status IN ('requested','accepted','arrived')",
      [now(), by, str(req.body.reason, 200), r.id]);
    if (!ch) throw httpError(409, r.status === 'started' ? 'A started ride cannot be cancelled. Ask the rider to end it, or use SOS.' : 'This ride is already finished.');
    log(`[ride ${r.id}] cancelled by ${by}`);
    await closeOffers(r.id); await pushRide(r.id);
    res.json({ ride: rideView(await getRide(r.id), u.role) });
  }));
  app.post('/api/rides/:id/rate', auth('passenger'), wrap(async (req, res) => {
    const stars = num(req.body.stars, 1, 5);
    if (!stars || !Number.isInteger(stars)) throw httpError(400, 'Rating must be 1 to 5.');
    const r = await db.one("UPDATE rides SET rating = $1 WHERE id = $2 AND passenger_id = $3 AND status = 'completed' AND rating IS NULL RETURNING driver_id", [stars, +req.params.id || 0, req.user.id]);
    if (!r) throw httpError(409, 'This ride cannot be rated (not completed, or already rated).');
    await db.exec('UPDATE drivers SET rating_sum = rating_sum + $1, rating_count = rating_count + 1 WHERE user_id = $2', [stars, r.driver_id]);
    res.json({ ok: true });
  }));

  // ---------------- rides: rider (driver)
  async function requireApproved(u) {
    const d = await driverRow(u.id);
    if (!d) throw httpError(400, 'Complete your vehicle details first.');
    if (d.status !== 'approved') throw httpError(403, d.status === 'rejected' ? 'Your rider application was rejected. Contact SafeShe support.' : 'Your account is waiting for admin approval.');
    return d;
  }
  app.post('/api/driver/online', auth('driver'), wrap(async (req, res) => {
    await requireApproved(req.user);
    const on = !!req.body.online, p = point(req.body);
    if (on && !p) throw httpError(400, 'Location is required to go online.');
    if (on) {
      const ps = await paymentSettings();
      if (ps.duesLimit > 0) {
        const d = await duesFor(req.user.id);
        if (d.toPay > ps.duesLimit) throw httpError(402, `Please pay your SafeShe commission of ₹${d.toPay} to go online (limit ₹${ps.duesLimit}).`);
      }
    }
    if (!on && await activeRideFor(req.user.id, 'driver')) throw httpError(409, 'Finish your current ride before going offline.');
    if (p) await db.exec('UPDATE drivers SET online = $1, lat = $2, lng = $3, loc_at = $4, updated_at = $4 WHERE user_id = $5', [on, p.lat, p.lng, now(), req.user.id]);
    else await db.exec('UPDATE drivers SET online = $1, updated_at = $2 WHERE user_id = $3', [on, now(), req.user.id]);
    log(`[rider ${req.user.id}] ${on ? 'online' : 'offline'}`);
    if (on) await tick(true);
    res.json({ user: await publicUser(req.user), offers: on ? await openOffersFor(req.user.id) : [] });
  }));
  app.post('/api/driver/location', auth('driver'), wrap(async (req, res) => {
    const p = point(req.body); if (!p) throw httpError(400, 'Invalid location.');
    await updateDriverLocation(req.user.id, p);
    res.json({ ok: true });
  }));
  app.get('/api/driver/offers', auth('driver'), wrap(async (req, res) => res.json({ offers: await openOffersFor(req.user.id) })));
  app.post('/api/rides/:id/decline', auth('driver'), wrap(async (req, res) => {
    await db.exec('UPDATE ride_offers SET declined = TRUE WHERE ride_id = $1 AND driver_id = $2', [+req.params.id || 0, req.user.id]);
    res.json({ ok: true });
  }));
  app.post('/api/rides/:id/accept', auth('driver'), wrap(async (req, res) => {
    const d = await requireApproved(req.user);
    if (!d.online) throw httpError(409, 'Go online to accept rides.');
    if (await activeRideFor(req.user.id, 'driver')) throw httpError(409, 'Finish your current ride first.');
    const r = await db.one('SELECT * FROM rides WHERE id = $1', [+req.params.id || 0]);
    if (!r) throw httpError(404, 'Ride not found.');
    if (!matches({ ...d, gender: req.user.gender }, r.vehicle)) throw httpError(403, 'This ride needs a different vehicle type.');
    // Atomic: only the first rider to accept gets the ride.
    const ch = await db.exec("UPDATE rides SET status = 'accepted', driver_id = $1, accepted_at = $2 WHERE id = $3 AND status = 'requested'", [req.user.id, now(), r.id]);
    if (!ch) throw httpError(409, 'Sorry, this ride was taken by another rider or cancelled.');
    log(`[ride ${r.id}] accepted by rider ${req.user.id}`);
    await closeOffers(r.id); await pushRide(r.id);
    res.json({ ride: rideView(await getRide(r.id), 'driver') });
  }));
  async function driverStep(req, from, to, col, otpCheck) {
    const r = await getRide(+req.params.id || 0);
    if (!r || r.driver_id !== req.user.id) throw httpError(404, 'Ride not found.');
    if (!from.includes(r.status)) throw httpError(409, `Ride is ${r.status}.`);
    if (otpCheck && !sec.safeEqual(str(req.body.otp, 4), r.otp)) throw httpError(400, 'Wrong OTP. Ask the passenger for the 4-digit ride OTP.');
    // On completion, record the platform commission for this ride (current rate for its vehicle type).
    const commission = to === 'completed' ? commissionFor((await fares()).find(f => f.vehicle === r.vehicle), r.fare) : r.commission;
    const ch = await db.exec(`UPDATE rides SET status = $1, ${col} = $2, commission = $5 WHERE id = $3 AND status = ANY($4)`, [to, now(), r.id, from, commission]);
    if (!ch) throw httpError(409, 'The ride changed. Please refresh.');
    log(`[ride ${r.id}] ${to}`);
    await pushRide(r.id);
    return rideView(await getRide(r.id), 'driver');
  }
  app.post('/api/rides/:id/arrived', auth('driver'), wrap(async (req, res) => res.json({ ride: await driverStep(req, ['accepted'], 'arrived', 'arrived_at') })));
  app.post('/api/rides/:id/start', auth('driver'), wrap(async (req, res) => res.json({ ride: await driverStep(req, ['arrived', 'accepted'], 'started', 'started_at', true) })));
  app.post('/api/rides/:id/complete', auth('driver'), wrap(async (req, res) => res.json({ ride: await driverStep(req, ['started'], 'completed', 'completed_at') })));

  // ---------------- rider: commission dues and UPI payments to the admin
  app.get('/api/driver/dues', auth('driver'), wrap(async (req, res) => {
    const [dues, ps, payments, recent] = await Promise.all([
      duesFor(req.user.id), paymentSettings(),
      db.q('SELECT id, amount, utr, status, created_at, reviewed_at, note FROM commission_payments WHERE driver_id = $1 ORDER BY id DESC LIMIT 20', [req.user.id]),
      db.q("SELECT id, vehicle, fare, commission, completed_at FROM rides WHERE driver_id = $1 AND status = 'completed' ORDER BY id DESC LIMIT 20", [req.user.id]),
    ]);
    res.json({ ...dues, upiId: ps.upiId, payeeName: ps.payeeName, duesLimit: ps.duesLimit,
      payments: payments.map(p => ({ id: p.id, amount: p.amount, utr: p.utr, status: p.status, createdAt: p.created_at, reviewedAt: p.reviewed_at, note: p.note })),
      rides: recent.map(r => ({ id: r.id, vehicle: r.vehicle, fare: r.fare, commission: r.commission, completedAt: r.completed_at })) });
  }));
  app.post('/api/driver/payments', auth('driver'), wrap(async (req, res) => {
    const amount = num(req.body.amount, 1, 100000);
    const utr = str(req.body.utr, 40).replace(/\s+/g, '').toUpperCase();
    if (!amount) throw httpError(400, 'Enter the amount you paid.');
    if (!/^[A-Z0-9]{6,35}$/.test(utr)) throw httpError(400, 'Enter the UPI transaction reference (UTR / UPI Ref No.), usually 12 digits, from your UPI app.');
    if (await db.one('SELECT 1 AS x FROM commission_payments WHERE UPPER(utr) = $1', [utr])) throw httpError(409, 'This UPI reference was already submitted.');
    const p = await db.one('INSERT INTO commission_payments (driver_id, amount, utr, created_at) VALUES ($1,$2,$3,$4) RETURNING id', [req.user.id, round2(amount), utr, now()]);
    log(`[payment ${p.id}] rider ${req.user.id} reported ₹${amount} (UTR ${utr})`);
    await emit('admins', 'admin:payment', { id: p.id, driverId: req.user.id, name: req.user.name, amount: round2(amount) });
    res.json({ ok: true, id: p.id, dues: await duesFor(req.user.id) });
  }));

  // ---------------- SOS + public tracking
  async function sosView(s) {
    const u = await getUser(s.user_id);
    const r = s.ride_id ? await getRide(s.ride_id) : null;
    return { id: s.id, createdAt: s.created_at, resolvedAt: s.resolved_at, resolvedNote: s.resolved_note, lat: s.lat, lng: s.lng, accuracy: s.accuracy, message: s.message,
      user: u && { id: u.id, name: u.name, phone: u.phone, role: u.role, emergencyPhone: u.emergency_phone }, ride: r ? rideView(r, 'admin') : null };
  }
  app.post('/api/sos', auth(), wrap(async (req, res) => {
    const p = point(req.body) || {};
    const ride = await activeRideFor(req.user.id, req.user.role);
    const s = await db.one('INSERT INTO sos (user_id, ride_id, lat, lng, accuracy, message, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.id, ride ? ride.id : null, p.lat ?? null, p.lng ?? null, num(req.body.accuracy, 0, 1e6), str(req.body.message, 1000), now()]);
    log(`[SOS ${s.id}] from user ${req.user.id} (${req.user.role})${ride ? ' on ride ' + ride.id : ''}`);
    await emit('admins', 'admin:sos', await sosView(s));
    res.json({ ok: true, id: s.id });
  }));
  app.get('/api/track/:token', wrap(async (req, res) => {
    const r = await db.one(RIDE_SELECT + ' WHERE r.share_token = $1', [str(req.params.token, 40)]);
    const fresh = r && (ACTIVE.includes(r.status) || (r.completed_at || r.cancelled_at || 0) > now() - 30 * 60_000);
    if (!fresh) return res.status(404).json({ error: 'This tracking link has expired.' });
    const v = rideView(r, 'track');
    res.json({ status: v.status, vehicle: v.vehicle, pickup: v.pickup, drop: v.drop, startedAt: v.startedAt, completedAt: v.completedAt,
      passenger: { name: (v.passenger.name || '').split(' ')[0] },
      driver: v.driver && { name: v.driver.name, vehicleModel: v.driver.vehicleModel, plate: v.driver.plate, lat: v.driver.lat, lng: v.driver.lng, locAt: v.driver.locAt } });
  }));

  // ---------------- admin
  const admin = auth('admin');
  app.get('/api/admin/stats', admin, wrap(async (req, res) => {
    const day = new Date(); day.setHours(0, 0, 0, 0); const d0 = day.getTime();
    const s = await db.one(`SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'passenger') AS passengers,
      (SELECT COUNT(*) FROM users WHERE role = 'driver') AS riders,
      (SELECT COUNT(*) FROM drivers WHERE status = 'pending') AS riders_pending,
      (SELECT COUNT(*) FROM rides WHERE status IN ('requested','accepted','arrived','started')) AS active_rides,
      (SELECT COUNT(*) FROM rides WHERE requested_at >= $1) AS rides_today,
      (SELECT COUNT(*) FROM rides WHERE status = 'completed' AND completed_at >= $1) AS completed_today,
      (SELECT COALESCE(SUM(fare), 0) FROM rides WHERE status = 'completed' AND completed_at >= $1) AS revenue_today,
      (SELECT COUNT(*) FROM sos WHERE resolved_at IS NULL) AS open_sos,
      (SELECT COALESCE(SUM(commission), 0) FROM rides WHERE status = 'completed' AND completed_at >= $1) AS commission_today,
      (SELECT COALESCE(SUM(commission), 0) FROM rides WHERE status = 'completed') - (SELECT COALESCE(SUM(amount), 0) FROM commission_payments WHERE status = 'confirmed') AS commission_due,
      (SELECT COUNT(*) FROM commission_payments WHERE status = 'pending') AS payments_pending`, [d0]);
    res.json({ passengers: s.passengers, riders: s.riders, ridersOnline: (await availableDrivers()).length, ridersPending: s.riders_pending,
      activeRides: s.active_rides, ridesToday: s.rides_today, completedToday: s.completed_today, revenueToday: s.revenue_today, openSos: s.open_sos, otpTestMode: otp.testMode,
      commissionToday: round2(s.commission_today), commissionDue: round2(Math.max(0, s.commission_due)), paymentsPending: s.payments_pending });
  }));
  app.get('/api/admin/riders', admin, wrap(async (req, res) => {
    const st = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const rows = await db.q(`SELECT u.*, d.* FROM users u JOIN drivers d ON d.user_id = u.id ${st ? 'WHERE d.status = $1' : ''} ORDER BY d.updated_at DESC LIMIT 200`, st ? [st] : []);
    res.json({ riders: rows.map(r => ({ id: r.user_id, name: r.name, phone: r.phone, gender: r.gender, blocked: r.blocked, vehicleType: r.vehicle_type, vehicleModel: r.vehicle_model, plate: r.plate,
      licenseNo: r.license_no, status: r.status, online: r.online, rating: r.rating_count ? +(r.rating_sum / r.rating_count).toFixed(1) : null, createdAt: r.created_at })) });
  }));
  app.post('/api/admin/riders/:id/:action', admin, wrap(async (req, res) => {
    const id = +req.params.id || 0, act = req.params.action;
    if (act !== 'approve' && act !== 'reject') throw httpError(400, 'Unknown action.');
    const st = act === 'approve' ? 'approved' : 'rejected';
    const ch = await db.exec("UPDATE drivers SET status = $1, online = CASE WHEN $1 = 'rejected' THEN FALSE ELSE online END, updated_at = $2 WHERE user_id = $3", [st, now(), id]);
    if (!ch) throw httpError(404, 'Rider not found.');
    await emit('user:' + id, 'driver:status', { status: st });
    log(`[admin] rider ${id} ${st}`);
    res.json({ ok: true });
  }));
  app.get('/api/admin/users', admin, wrap(async (req, res) => {
    const role = ['passenger', 'driver'].includes(req.query.role) ? req.query.role : null, q = str(req.query.q, 40);
    const where = [], args = [];
    if (role) { args.push(role); where.push(`u.role = $${args.length}`); }
    if (q) { args.push(`%${q}%`); where.push(`(u.phone ILIKE $${args.length} OR u.name ILIKE $${args.length})`); }
    const rows = await db.q(`SELECT u.*, (SELECT COUNT(*) FROM rides r WHERE r.passenger_id = u.id OR r.driver_id = u.id) AS rides
      FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.id DESC LIMIT 200`, args);
    res.json({ users: rows.map(u => ({ id: u.id, phone: u.phone, role: u.role, name: u.name, gender: u.gender, emergencyPhone: u.emergency_phone, createdAt: u.created_at, blocked: u.blocked, rides: u.rides })) });
  }));
  app.post('/api/admin/users/:id/:action', admin, wrap(async (req, res) => {
    const id = +req.params.id || 0, act = req.params.action;
    if (act !== 'block' && act !== 'unblock') throw httpError(400, 'Unknown action.');
    const ch = await db.exec('UPDATE users SET blocked = $1 WHERE id = $2', [act === 'block', id]);
    if (!ch) throw httpError(404, 'User not found.');
    if (act === 'block') {
      await db.exec("DELETE FROM sessions WHERE kind = 'user' AND subject_id = $1", [id]);
      await db.exec('UPDATE drivers SET online = FALSE WHERE user_id = $1', [id]);
      await emit('user:' + id, 'account:blocked', {});
    }
    log(`[admin] user ${id} ${act}ed`);
    res.json({ ok: true });
  }));
  app.get('/api/admin/rides', admin, wrap(async (req, res) => {
    const st = String(req.query.status || '');
    let rows;
    if (st === 'active') rows = await db.q(RIDE_SELECT + ' WHERE r.status = ANY($1) ORDER BY r.id DESC LIMIT 200', [ACTIVE]);
    else if (st) rows = await db.q(RIDE_SELECT + ' WHERE r.status = $1 ORDER BY r.id DESC LIMIT 200', [st]);
    else rows = await db.q(RIDE_SELECT + ' ORDER BY r.id DESC LIMIT 200');
    res.json({ rides: rows.map(r => rideView(r, 'admin')) });
  }));
  app.post('/api/admin/rides/:id/cancel', admin, wrap(async (req, res) => {
    const id = +req.params.id || 0;
    const ch = await db.exec("UPDATE rides SET status = 'cancelled', cancelled_at = $1, cancelled_by = 'admin', cancel_reason = $2 WHERE id = $3 AND status = ANY($4)",
      [now(), str(req.body.reason, 200) || 'Cancelled by SafeShe support', id, ACTIVE]);
    if (!ch) throw httpError(409, 'Ride is not active.');
    await closeOffers(id); await pushRide(id);
    log(`[admin] ride ${id} cancelled`);
    res.json({ ok: true });
  }));
  app.get('/api/admin/sos', admin, wrap(async (req, res) => {
    const rows = await db.q(`SELECT * FROM sos ${req.query.open === '1' ? 'WHERE resolved_at IS NULL' : ''} ORDER BY id DESC LIMIT 100`);
    res.json({ sos: await Promise.all(rows.map(sosView)) });
  }));
  app.post('/api/admin/sos/:id/resolve', admin, wrap(async (req, res) => {
    const ch = await db.exec('UPDATE sos SET resolved_at = $1, resolved_note = $2 WHERE id = $3 AND resolved_at IS NULL', [now(), str(req.body.note, 500), +req.params.id || 0]);
    if (!ch) throw httpError(404, 'Alert not found or already resolved.');
    res.json({ ok: true });
  }));
  app.get('/api/admin/fares', admin, wrap(async (req, res) => res.json({ fares: await fares() })));
  app.put('/api/admin/fares', admin, wrap(async (req, res) => {
    const list = Array.isArray(req.body.fares) ? req.body.fares : [];
    for (const f of list) {
      if (!VEHICLES.includes(f.vehicle)) continue;
      const vals = [num(f.base, 0, 10000), num(f.per_km, 0, 1000), num(f.per_min, 0, 1000), num(f.min_fare, 0, 10000)];
      if (vals.some(v => v == null)) throw httpError(400, `Invalid fare values for ${f.vehicle}.`);
      const ctype = f.commission_type === 'percent' ? 'percent' : 'flat';
      const cval = num(f.commission_value == null ? 0 : f.commission_value, 0, ctype === 'percent' ? 50 : 1000);
      if (cval == null) throw httpError(400, `Invalid commission for ${f.vehicle} (${ctype === 'percent' ? '0–50 %' : '₹0–1000'}).`);
      await db.exec('UPDATE fares SET name=$1, base=$2, per_km=$3, per_min=$4, min_fare=$5, active=$6, commission_type=$7, commission_value=$8 WHERE vehicle=$9',
        [str(f.name, 30) || f.vehicle, ...vals, !!f.active, ctype, cval, f.vehicle]);
    }
    log('[admin] fares updated');
    res.json({ fares: await fares() });
  }));

  // ---------------- admin: UPI settings, commission dues, payment review
  app.get('/api/admin/payment-settings', admin, wrap(async (req, res) => res.json(await paymentSettings())));
  app.put('/api/admin/payment-settings', admin, wrap(async (req, res) => {
    const upi = str(req.body.upiId, 300).replace(/\s+/g, '');
    if (upi && !UPI_RE.test(upi)) throw httpError(400, 'Enter a valid UPI ID, e.g. yourname@okaxis or 9876543210@ybl.');
    const name = str(req.body.payeeName, 60) || 'SafeShe';
    const limit = num(req.body.duesLimit == null || req.body.duesLimit === '' ? 0 : req.body.duesLimit, 0, 100000);
    if (limit == null) throw httpError(400, 'Dues limit must be a number (0 = no limit).');
    for (const [k, v] of [['pay_upi', upi], ['pay_name', name], ['pay_limit', String(limit)]])
      await db.exec('INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
    log('[admin] payment settings updated');
    res.json(await paymentSettings());
  }));
  app.get('/api/admin/dues', admin, wrap(async (req, res) => {
    const rows = await db.q(`SELECT u.id, u.name, u.phone, d.vehicle_type, d.plate,
        COALESCE((SELECT SUM(commission) FROM rides r WHERE r.driver_id = u.id AND r.status = 'completed'), 0) AS charged,
        COALESCE((SELECT SUM(amount) FROM commission_payments p WHERE p.driver_id = u.id AND p.status = 'confirmed'), 0) AS paid,
        COALESCE((SELECT SUM(amount) FROM commission_payments p WHERE p.driver_id = u.id AND p.status = 'pending'), 0) AS pending
      FROM users u JOIN drivers d ON d.user_id = u.id ORDER BY u.id DESC LIMIT 500`);
    const riders = rows.map(r => ({ id: r.id, name: r.name, phone: r.phone, vehicleType: r.vehicle_type, plate: r.plate,
      charged: round2(r.charged), paid: round2(r.paid), pending: round2(r.pending), due: round2(Math.max(0, r.charged - r.paid)) }))
      .filter(r => r.charged > 0 || r.pending > 0).sort((a, b) => b.due - a.due);
    const totals = riders.reduce((t, r) => ({ charged: t.charged + r.charged, paid: t.paid + r.paid, due: t.due + r.due, pending: t.pending + r.pending }), { charged: 0, paid: 0, due: 0, pending: 0 });
    Object.keys(totals).forEach(k => { totals[k] = round2(totals[k]); });
    res.json({ riders, totals });
  }));
  app.get('/api/admin/payments', admin, wrap(async (req, res) => {
    const st = ['pending', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const rows = await db.q(`SELECT p.*, u.name, u.phone FROM commission_payments p JOIN users u ON u.id = p.driver_id ${st ? 'WHERE p.status = $1' : ''} ORDER BY p.id DESC LIMIT 200`, st ? [st] : []);
    res.json({ payments: rows.map(p => ({ id: p.id, driverId: p.driver_id, name: p.name, phone: p.phone, amount: p.amount, utr: p.utr, status: p.status, createdAt: p.created_at, reviewedAt: p.reviewed_at, note: p.note })) });
  }));
  app.post('/api/admin/payments/:id/:action', admin, wrap(async (req, res) => {
    const act = req.params.action;
    if (act !== 'confirm' && act !== 'reject') throw httpError(400, 'Unknown action.');
    const st = act === 'confirm' ? 'confirmed' : 'rejected';
    const p = await db.one("UPDATE commission_payments SET status = $1, reviewed_at = $2, note = $3 WHERE id = $4 AND status = 'pending' RETURNING driver_id, amount", [st, now(), str(req.body.note, 300) || null, +req.params.id || 0]);
    if (!p) throw httpError(404, 'Payment not found or already reviewed.');
    await emit('user:' + p.driver_id, 'payment:update', { id: +req.params.id, status: st, amount: p.amount });
    log(`[admin] payment ${req.params.id} ${st}`);
    res.json({ ok: true });
  }));
  app.get('/api/admin/otps', admin, wrap(async (req, res) => res.json({ testMode: otp.testMode, codes: await otp.recentTestCodes() })));
  app.get('/api/admin/sms-status', admin, wrap(async (req, res) => res.json(await otp.smsStatus())));
  app.post('/api/admin/sms-test', admin, wrap(async (req, res) => {
    const phone = sec.normalizePhone(req.body.phone);
    if (!phone) throw httpError(400, 'Enter a valid 10-digit Indian mobile number.');
    await otp.sendTest(phone);
    log(`[admin] test SMS sent to ${phone}`);
    res.json({ ok: true, message: 'Test SMS sent to ' + phone + '. It should arrive within a minute.' });
  }));
  app.get('/api/admin/me', admin, wrap(async (req, res) => {
    res.json({ admin: await db.one('SELECT id, username, email FROM admins WHERE id = $1', [req.s.admin.id]) });
  }));
  app.put('/api/admin/email', admin, wrap(async (req, res) => {
    const email = str(req.body.email, 200).toLowerCase();
    if (email && !EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address, e.g. name@gmail.com.');
    const clash = email && await db.one('SELECT id FROM admins WHERE LOWER(email) = $1 AND id <> $2', [email, req.s.admin.id]);
    if (clash) throw httpError(409, 'Another admin already uses this email.');
    await db.exec('UPDATE admins SET email = $1 WHERE id = $2', [email || null, req.s.admin.id]);
    log(`[admin] admin ${req.s.admin.id} email ${email ? 'set' : 'removed'}`);
    res.json({ ok: true, email: email || null });
  }));
  app.post('/api/admin/password', admin, wrap(async (req, res) => {
    const a = await db.one('SELECT * FROM admins WHERE id = $1', [req.s.admin.id]);
    if (!sec.verifyPassword(String(req.body.current || ''), a.pass_hash)) throw httpError(400, 'Current password is wrong.');
    const pw = String(req.body.next || '');
    if (pw.length < 8) throw httpError(400, 'New password must be at least 8 characters.');
    await db.exec('UPDATE admins SET pass_hash = $1 WHERE id = $2', [sec.hashPassword(pw), a.id]);
    await db.exec("DELETE FROM sessions WHERE kind = 'admin' AND subject_id = $1 AND token_hash <> $2", [a.id, sec.sha256(bearer(req))]);
    res.json({ ok: true });
  }));

  // ---------------- web app files (standalone mode; on Vercel they are served from /public)
  if (cfg.appDir) {
    app.get('/admin', (req, res) => res.redirect('/'));
    app.get('/t/:token', (req, res) => res.sendFile(path.join(cfg.appDir, 'track.html')));
    app.use(express.static(cfg.appDir, { index: 'index.html', maxAge: '5m' }));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500 && !err.status) log('[error]', err.stack || err.message);
    res.status(status).json({ error: status >= 500 && !err.status ? (/DATABASE_URL/.test(err.message) ? err.message : 'Something went wrong. Please try again.') : err.message });
  });

  return { app, db, cfg, init, tick, close: () => db.close() };
}

module.exports = { createApp, loadConfig };
