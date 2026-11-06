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
const pricingEngine = require('./pricing');
const reports = require('./report');
const { parseBankSms } = require('./bankalert');

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
      if (await otp.isTestMode()) log('[otp] TEST MODE: no 2Factor API key (env or Admin → Settings), so OTPs are not sent by SMS.');
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

  // Logins stay valid until the user logs out: every use slides the expiry forward
  // (users: 1 year of inactivity, admin: 30 days). Blocking a user or logging out ends the session.
  const sessionTtl = kind => kind === 'admin' ? 30 * 24 * 3600_000 : 365 * 24 * 3600_000;
  async function issueSession(kind, id) {
    const t = sec.token();
    await db.exec('INSERT INTO sessions (token_hash, kind, subject_id, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)', [sec.sha256(t), kind, id, now(), now() + sessionTtl(kind)]);
    return t;
  }
  async function sessionFrom(tokenStr) {
    if (!tokenStr) return null;
    const s = await db.one('SELECT * FROM sessions WHERE token_hash = $1', [sec.sha256(tokenStr)]);
    if (!s || s.expires_at < now()) return null;
    if (s.expires_at - now() < sessionTtl(s.kind) - 24 * 3600_000) // extend at most once a day
      await db.exec('UPDATE sessions SET expires_at = $1 WHERE token_hash = $2', [now() + sessionTtl(s.kind), s.token_hash]);
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
      out.driver = d ? { vehicleType: d.vehicle_type, vehicleModel: d.vehicle_model, plate: d.plate, licenseNo: d.license_no, status: d.status, online: d.online, upiId: d.upi_id || '',
        rating: d.rating_count ? +(d.rating_sum / d.rating_count).toFixed(2) : null, ratingCount: d.rating_count } : null;
    }
    return out;
  }
  const fares = () => db.q('SELECT * FROM fares ORDER BY sort');

  // ---------------- pricing settings (night premium, pickup surcharge, gridlock, rider tiers)
  const round2 = n => Math.round(n * 100) / 100;
  async function pricing() {
    const r = await db.one("SELECT value FROM kv WHERE key = 'pricing'");
    let stored = null; try { stored = r ? JSON.parse(r.value) : null; } catch (e) { stored = null; }
    return pricingEngine.normalizePricing(stored);
  }
  // ---------------- service regions (admin-controlled): where SafeShe is reachable
  const regionsAll = () => db.q('SELECT * FROM regions ORDER BY sort, name');
  const regionView = r => r && ({ id: r.id, name: r.name, state: r.state, lat: r.lat, lng: r.lng, radiusKm: r.radius_km, active: r.active });
  /** Nearest region whose circle contains point p (optionally active regions only). */
  function regionContaining(regs, p, activeOnly) {
    let best = null, bestKm = Infinity;
    for (const r of regs) {
      if (activeOnly && !r.active) continue;
      const km = haversineKm(r, p);
      if (km <= r.radius_km && km < bestKm) { best = r; bestKm = km; }
    }
    return best;
  }
  /** Pickup and drop must both be inside the same active region. */
  async function requireServiceable(a, b) {
    const regs = await regionsAll();
    const ra = regionContaining(regs, a, true);
    if (!ra) {
      const soon = regionContaining(regs, a, false);
      throw Object.assign(new Error(soon ? `SafeShe is coming soon to ${soon.name}. Rides are not available there yet.`
        : 'SafeShe is not available at this pickup location yet. Choose a pickup inside a SafeShe city.'), { status: 403, code: 'not_serviceable' });
    }
    if (haversineKm(ra, b) > ra.radius_km)
      throw Object.assign(new Error(`This drop is outside the ${ra.name} service area. Choose a destination within ${ra.radius_km} km of the city centre.`), { status: 403, code: 'drop_outside' });
    return ra;
  }
  /** The rider's pass covering time `at`, if any. */
  const activePass = (driverId, at) => db.one('SELECT * FROM driver_passes WHERE driver_id = $1 AND starts_at <= $2 AND ends_at > $2 ORDER BY ends_at DESC LIMIT 1', [driverId, at]);

  // ---------------- what riders owe the admin: platform fees + Fares minimum amounts (rides.commission) + passes
  const UPI_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/;
  async function paymentSettings() {
    const rows = await db.q("SELECT key, value FROM kv WHERE key IN ('pay_upi', 'pay_name', 'pay_limit')");
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return { upiId: m.pay_upi || '', payeeName: m.pay_name || 'SafeShe', duesLimit: +m.pay_limit || 0 };
  }
  async function duesFor(driverId) {
    const r = await db.one(`SELECT
      (SELECT COALESCE(SUM(commission), 0) FROM rides WHERE driver_id = $1 AND status = 'completed') AS ride_fees,
      (SELECT COALESCE(SUM(platform_fee), 0) FROM rides WHERE driver_id = $1 AND status = 'completed') AS platform_fees,
      (SELECT COALESCE(SUM(price), 0) FROM driver_passes WHERE driver_id = $1) AS passes,
      (SELECT COALESCE(SUM(amount), 0) FROM commission_payments WHERE driver_id = $1 AND status = 'confirmed') AS paid,
      (SELECT COALESCE(SUM(amount), 0) FROM commission_payments WHERE driver_id = $1 AND status = 'pending') AS pending`, [driverId]);
    const charged = r.ride_fees + r.platform_fees + r.passes;
    const due = round2(Math.max(0, charged - r.paid));
    return { charged: round2(charged), rideFees: round2(r.ride_fees), platformFees: round2(r.platform_fees), passes: round2(r.passes),
      paid: round2(r.paid), pending: round2(r.pending), due, toPay: round2(Math.max(0, due - r.pending)) };
  }
  /** Upfront fare breakdown for a fares row at time `at` (pickup surcharge / traffic minutes added later). */
  const quoteFare = (f, km, at, P, extra = {}) => pricingEngine.computeFare(f, { km, night: pricingEngine.isNight(at, P), ...extra }, P);
  const shareUrl = token => (cfg.publicUrl || '') + '/t/' + token;

  const RIDE_SELECT = `SELECT r.*, p.name AS p_name, p.phone AS p_phone,
      du.name AS d_name, du.phone AS d_phone, du.gender AS d_gender,
      d.vehicle_type AS d_vtype, d.vehicle_model AS d_model, d.plate AS d_plate, d.rating_sum AS d_rsum, d.rating_count AS d_rcount, d.upi_id AS d_upi,
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
      completedAt: r.completed_at, cancelledAt: r.cancelled_at, cancelledBy: r.cancelled_by, cancelReason: r.cancel_reason, rating: r.rating, collectedAt: r.collected_at || null,
      passenger: { id: r.passenger_id, name: r.p_name, phone: showPhone ? r.p_phone : undefined },
      driver: r.driver_id ? {
        id: r.driver_id, name: r.d_name, gender: r.d_gender, phone: showPhone ? r.d_phone : undefined,
        vehicleType: r.d_vtype, vehicleModel: r.d_model, plate: r.d_plate, upiId: viewer === 'track' ? undefined : (r.d_upi || ''),
        rating: r.d_rcount ? +(r.d_rsum / r.d_rcount).toFixed(1) : null, lat: r.d_lat, lng: r.d_lng, locAt: r.d_loc_at,
      } : null,
    };
    if (viewer === 'passenger' || viewer === 'admin') { out.otp = r.otp; out.shareUrl = shareUrl(r.share_token); out.shareToken = r.share_token; }
    // Fare details: upfront fare at booking; the final fare can add a long-pickup surcharge and gridlock time.
    out.upfrontFare = r.upfront_fare != null ? r.upfront_fare : r.fare;
    out.night = !!r.night; out.platformFee = r.platform_fee || 0; out.pickupSurcharge = r.pickup_surcharge || 0;
    out.breakdown = r.breakdown || null;
    if (r.gridlock) out.trafficMin = round2((r.gridlock.sec || 0) / 60);
    if (viewer === 'driver' || viewer === 'admin') {
      out.commission = r.commission || 0; out.tier = r.tier || null;
      out.driverKeeps = round2(r.fare - (r.platform_fee || 0)); // platform fee is passed to SafeShe; pickup surcharge stays 100% with the rider
      // SafeShe's share of this ride (paid by the rider to the admin's UPI ID): the admin's Fares values only,
      // platform fee + minimum amount for this vehicle (commission holds the minimum amount, 0 while a pass is active).
      out.safeSheShare = r.status === 'completed' ? round2((r.platform_fee || 0) + (r.commission || 0)) : null;
    }
    return out;
  }

  async function pushRide(id) {
    const r = await getRide(id); if (!r) return;
    await emit('user:' + r.passenger_id, 'ride:update', rideView(r, 'passenger'));
    if (r.driver_id) await emit('user:' + r.driver_id, 'ride:update', rideView(r, 'driver'));
    await emit('admins', 'admin:ride', { id: r.id, status: r.status });
  }
  async function updateDriverLocation(userId, p) {
    const t = now();
    await db.exec('UPDATE drivers SET lat = $1, lng = $2, loc_at = $3 WHERE user_id = $4', [p.lat, p.lng, t, userId]);
    const r = await db.one("SELECT id, passenger_id, status, gridlock FROM rides WHERE driver_id = $1 AND status IN ('accepted','arrived','started') LIMIT 1", [userId]);
    if (!r) return;
    if (r.status === 'started') {
      // Gridlock trigger: bill per-minute only while slower than the threshold for long enough.
      const g = pricingEngine.trackGridlock(r.gridlock, p, t, await pricing(), haversineKm);
      await db.exec("UPDATE rides SET gridlock = $1 WHERE id = $2 AND status = 'started'", [JSON.stringify(g), r.id]);
    }
    await emit('user:' + r.passenger_id, 'ride:driver_location', { rideId: r.id, lat: p.lat, lng: p.lng, at: t });
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
  function offerView(r, d, P) {
    const pickupKm = d && d.lat != null ? +haversineKm({ lat: r.pickup_lat, lng: r.pickup_lng }, d).toFixed(1) : null;
    const surcharge = P && pickupKm != null ? pricingEngine.pickupSurcharge(pickupKm, P) : 0;
    const fare = Math.round(r.fare + surcharge);
    return { rideId: r.id, vehicle: r.vehicle, fare, payment: r.payment, distanceKm: +r.distance_km.toFixed(1), durationMin: Math.round(r.duration_min),
      pickup: { lat: r.pickup_lat, lng: r.pickup_lng, name: r.pickup_name }, drop: { lat: r.drop_lat, lng: r.drop_lng, name: r.drop_name },
      pickupKm, pickupSurcharge: surcharge, night: !!r.night, platformFee: r.platform_fee || 0,
      youKeep: round2(fare - (r.platform_fee || 0)), expiresAt: r.requested_at + cfg.searchMs };
  }
  async function dispatch(r, drivers) {
    if (!r || r.status !== 'requested') return;
    const pick = { lat: r.pickup_lat, lng: r.pickup_lng };
    const cands = (drivers || await availableDrivers()).filter(d => matches(d, r.vehicle) && haversineKm(pick, d) <= cfg.radiusKm)
      .sort((a, b) => haversineKm(pick, a) - haversineKm(pick, b));
    const P = cands.length ? await pricing() : null;
    for (const d of cands) {
      const ins = await db.exec('INSERT INTO ride_offers (ride_id, driver_id, offered_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [r.id, d.user_id, now()]);
      if (ins) await emit('user:' + d.user_id, 'ride:offer', offerView(r, d, P));
    }
  }
  async function closeOffers(rideId) {
    for (const o of await db.q('SELECT driver_id FROM ride_offers WHERE ride_id = $1', [rideId])) await emit('user:' + o.driver_id, 'ride:offer_closed', { rideId });
  }
  async function openOffersFor(driverId) {
    const d = await driverRow(driverId);
    const rows = await db.q("SELECT r.* FROM ride_offers o JOIN rides r ON r.id = o.ride_id WHERE o.driver_id = $1 AND NOT o.declined AND r.status = 'requested'", [driverId]);
    const P = await pricing();
    return rows.map(r => offerView(r, d, P));
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
    // Send the site origin (not the full URL) to other sites: map tile servers require a valid Referer.
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
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

  // Base map for the app. Default: OpenFreeMap (free vector map: no key, no registration, commercial use allowed),
  // with OpenStreetMap raster tiles as the no-WebGL fallback. Override with TILE_STYLE (vector style JSON URL)
  // or TILE_URL (raster tiles, e.g. a provider you have an account with).
  app.get('/api/config', (req, res) => res.json({ map: {
    style: cfg.env.TILE_URL && !cfg.env.TILE_STYLE ? null : (cfg.env.TILE_STYLE || 'https://tiles.openfreemap.org/styles/liberty'),
    url: cfg.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: cfg.env.TILE_SUBDOMAINS || 'abc', maxZoom: +cfg.env.TILE_MAX_ZOOM || 19,
    attribution: cfg.env.TILE_ATTRIBUTION || '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' } }));
  app.get('/api/health', wrap(async (req, res) => { await db.one('SELECT 1 AS ok'); res.json({ ok: true, otpTestMode: await otp.isTestMode(), node: process.version, time: now() }); }));

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
    // Rider's own UPI ID: passengers paying by UPI pay straight into this account.
    const upiId = str(req.body.upiId, 300).replace(/\s+/g, '');
    if (upiId && !UPI_RE.test(upiId)) throw httpError(400, 'Enter a valid UPI ID, e.g. yourname@okaxis or 9876543210@ybl.');
    const ex = await driverRow(req.user.id);
    if (ex) {
      // Changing vehicle details sends the rider back for approval.
      const changed = ex.vehicle_type !== vt || ex.plate !== plate || ex.license_no !== lic || ex.vehicle_model !== model;
      await db.exec('UPDATE drivers SET vehicle_type=$1, vehicle_model=$2, plate=$3, license_no=$4, status=$5, online = CASE WHEN $6 THEN FALSE ELSE online END, updated_at=$7 WHERE user_id=$8',
        [vt, model, plate, lic, changed ? 'pending' : ex.status, changed, now(), req.user.id]);
      if (changed) await emit('admins', 'admin:driver_pending', { id: req.user.id });
      await db.exec('UPDATE drivers SET upi_id = $1 WHERE user_id = $2', [upiId, req.user.id]); // UPI change needs no re-approval
    } else {
      await db.exec('INSERT INTO drivers (user_id, vehicle_type, vehicle_model, plate, license_no, status, updated_at, upi_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [req.user.id, vt, model, plate, lic, 'pending', now(), upiId]);
      await emit('admins', 'admin:driver_pending', { id: req.user.id });
    }
    res.json({ user: await publicUser(await getUser(req.user.id)) });
  }));

  // ---------------- geo
  let searchRegions = null;
  app.get('/api/geo/search', auth('any'), wrap(async (req, res) => {
    let near = req.query.lat ? point({ lat: req.query.lat, lng: req.query.lng }) : null;
    // With a region selected, search only inside that region (all nearby places in the city).
    let area = null;
    if (req.query.region) {
      // Region circle for the search area: cached for 60 s (one less database round trip per keystroke).
      if (!searchRegions || Date.now() - searchRegions.at > 60000) searchRegions = { at: Date.now(), list: await regionsAll() };
      const r = searchRegions.list.find(x => x.id === (+req.query.region || 0));
      if (r) { area = { lat: r.lat, lng: r.lng, radiusKm: r.radius_km }; if (!near || haversineKm(r, near) > r.radius_km) near = { lat: r.lat, lng: r.lng }; }
    }
    const t0 = Date.now(), results = await geo.search(req.query.q, near, req.query.suggest === '1', area);
    res.set('Server-Timing', `places;dur=${Date.now() - t0}`);
    res.json({ results });
  }));
  // Public list of regions (for the region picker): active = rides available, inactive = coming soon.
  app.get('/api/regions', wrap(async (req, res) => res.json({ regions: (await regionsAll()).map(regionView) })));
  app.get('/api/geo/reverse', auth('any'), wrap(async (req, res) => {
    const p = point(req.query); if (!p) throw httpError(400, 'Invalid location.');
    res.json(await geo.reverse(p.lat, p.lng));
  }));

  // ---------------- rides: passenger
  app.post('/api/rides/quote', auth('passenger'), wrap(async (req, res) => {
    const a = point(req.body.pickup), b = point(req.body.drop);
    if (!a || !b) throw httpError(400, 'Choose pickup and drop locations.');
    if (haversineKm(a, b) < 0.1) throw httpError(400, 'Pickup and drop are too close.');
    if (haversineKm(a, b) > 150) throw httpError(400, 'Rides are limited to 150 km.');
    const region = await requireServiceable(a, b);
    const [rt, online, fs, P] = await Promise.all([geo.route(a, b), availableDrivers(), fares(), pricing()]);
    const t = now(), night = pricingEngine.isNight(t, P);
    const opts = fs.filter(f => f.active).map(f => {
      const near = online.filter(d => matches(d, f.vehicle) && haversineKm(a, d) <= cfg.radiusKm);
      const nearestKm = near.length ? Math.min(...near.map(d => haversineKm(a, d))) : null;
      const eta = nearestKm != null ? Math.max(1, Math.round(nearestKm / 18 * 60)) : null;
      const b = quoteFare(f, rt.km, t, P);
      return { vehicle: f.vehicle, name: f.name, fare: b.total, breakdown: b, perMin: f.per_min, etaMin: eta, ridersNearby: near.length,
        maxPickupSurcharge: pricingEngine.pickupSurcharge(cfg.radiusKm, P) };
    });
    res.json({ km: +rt.km.toFixed(2), min: Math.round(rt.min), approx: rt.approx, points: rt.points, options: opts, night, region: regionView(region),
      nightMultiplier: P.night.multiplier, gridlock: { speedKmh: P.gridlock.speedKmh, minMinutes: P.gridlock.minMinutes },
      pickup: { freeKm: P.pickup.freeKm, perKm: P.pickup.perKm } });
  }));
  app.post('/api/rides', auth('passenger'), wrap(async (req, res) => {
    const u = req.user;
    if (!u.name) throw httpError(400, 'Complete your profile first.');
    if (await activeRideFor(u.id, 'passenger')) throw httpError(409, 'You already have an active ride.');
    const a = point(req.body.pickup), b = point(req.body.drop), vehicle = req.body.vehicle;
    if (!a || !b) throw httpError(400, 'Choose pickup and drop locations.');
    await requireServiceable(a, b);
    const f = (await fares()).find(x => x.vehicle === vehicle && x.active);
    if (!f) throw httpError(400, 'This ride type is not available.');
    const payment = req.body.payment === 'upi' ? 'upi' : 'cash';
    const [rt, P] = await Promise.all([geo.route(a, b), pricing()]);
    const t = now(), bd = quoteFare(f, rt.km, t, P);
    const row = await db.one(`INSERT INTO rides (passenger_id, vehicle, status, pickup_lat, pickup_lng, pickup_name, drop_lat, drop_lng, drop_name,
        distance_km, duration_min, route_approx, fare, payment, otp, share_token, requested_at, upfront_fare, platform_fee, night, breakdown)
      VALUES ($1,$2,'requested',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$12,$17,$18,$19) RETURNING id`,
      [u.id, vehicle, a.lat, a.lng, str(req.body.pickup.name, 200) || 'Pickup point', b.lat, b.lng, str(req.body.drop.name, 200) || 'Drop point',
        rt.km, rt.min, rt.approx, bd.total, payment, sec.digits(4), sec.token(12), t, bd.platformFee, bd.night, JSON.stringify(bd)]);
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
    // Long-pickup surcharge (100% to the rider) and the rider's plan (pass or pay-per-ride) are fixed at acceptance.
    const P = await pricing(), t = now();
    const f = (await fares()).find(x => x.vehicle === r.vehicle) || { base: r.fare, per_km: 0, per_min: 0 };
    const pickupKm = d.lat != null ? round2(haversineKm({ lat: r.pickup_lat, lng: r.pickup_lng }, d)) : 0;
    const surcharge = pricingEngine.pickupSurcharge(pickupKm, P);
    const bd = pricingEngine.computeFare(f, { km: r.distance_km, night: r.night, pickupSurcharge: surcharge }, P);
    const pass = await activePass(req.user.id, t);
    // Atomic: only the first rider to accept gets the ride.
    const ch = await db.exec(`UPDATE rides SET status = 'accepted', driver_id = $1, accepted_at = $2, pickup_km = $4, pickup_surcharge = $5,
        fare = $6, breakdown = $7, tier = $8 WHERE id = $3 AND status = 'requested'`,
      [req.user.id, t, r.id, pickupKm, surcharge, bd.total, JSON.stringify(bd), pass ? pass.kind : 'perRide']);
    if (!ch) throw httpError(409, 'Sorry, this ride was taken by another rider or cancelled.');
    log(`[ride ${r.id}] accepted by rider ${req.user.id}${surcharge ? ` (pickup ${pickupKm} km, +₹${surcharge})` : ''}`);
    await closeOffers(r.id); await pushRide(r.id);
    res.json({ ride: rideView(await getRide(r.id), 'driver') });
  }));
  async function driverStep(req, from, to, col, otpCheck) {
    const r = await getRide(+req.params.id || 0);
    if (!r || r.driver_id !== req.user.id) throw httpError(404, 'Ride not found.');
    if (!from.includes(r.status)) throw httpError(409, `Ride is ${r.status}.`);
    if (otpCheck && !sec.safeEqual(str(req.body.otp, 4), r.otp)) throw httpError(400, 'Wrong OTP. Ask the passenger for the 4-digit ride OTP.');
    // On completion: final fare = upfront fare + long-pickup surcharge + gridlock minutes.
    // SafeShe's share = platform fee + the vehicle's "Minimum ₹" from Admin → Fares (minimum waived while a pass is active).
    let fare = r.fare, breakdown = r.breakdown, commission = r.commission || 0;
    if (to === 'completed') {
      const P = await pricing();
      const f = (await fares()).find(x => x.vehicle === r.vehicle) || { base: r.fare, per_km: 0, per_min: 0 };
      const trafficMin = round2(((r.gridlock && r.gridlock.sec) || 0) / 60);
      const bd = pricingEngine.computeFare(f, { km: r.distance_km, night: r.night, pickupSurcharge: r.pickup_surcharge || 0, trafficMin }, P);
      fare = bd.total; breakdown = bd;
      commission = (r.tier || 'perRide') === 'perRide' ? round2(Math.max(0, +f.min_fare || 0)) : 0;
    }
    const ch = await db.exec(`UPDATE rides SET status = $1, ${col} = $2, commission = $5, fare = $6, breakdown = $7 WHERE id = $3 AND status = ANY($4)`,
      [to, now(), r.id, from, commission, fare, breakdown ? JSON.stringify(breakdown) : null]);
    if (!ch) throw httpError(409, 'The ride changed. Please refresh.');
    log(`[ride ${r.id}] ${to}`);
    await pushRide(r.id);
    return rideView(await getRide(r.id), 'driver');
  }
  app.post('/api/rides/:id/arrived', auth('driver'), wrap(async (req, res) => res.json({ ride: await driverStep(req, ['accepted'], 'arrived', 'arrived_at') })));
  app.post('/api/rides/:id/start', auth('driver'), wrap(async (req, res) => res.json({ ride: await driverStep(req, ['arrived', 'accepted'], 'started', 'started_at', true) })));
  app.post('/api/rides/:id/complete', auth('driver'), wrap(async (req, res) => res.json({ ride: await driverStep(req, ['started'], 'completed', 'completed_at') })));
  // Rider confirms the passenger paid (UPI to the rider's account, or cash).
  app.post('/api/rides/:id/collected', auth('driver'), wrap(async (req, res) => {
    const ch = await db.exec("UPDATE rides SET collected_at = $1 WHERE id = $2 AND driver_id = $3 AND status = 'completed' AND collected_at IS NULL", [now(), +req.params.id || 0, req.user.id]);
    if (!ch) { const r = await db.one('SELECT status, collected_at FROM rides WHERE id = $1 AND driver_id = $2', [+req.params.id || 0, req.user.id]); if (!r || r.status !== 'completed') throw httpError(404, 'Ride not found.'); }
    await pushRide(+req.params.id);
    res.json({ ride: rideView(await getRide(+req.params.id), 'driver'), dues: await duesFor(req.user.id) });
  }));

  // ---------------- rider: commission dues and UPI payments to the admin
  app.get('/api/driver/dues', auth('driver'), wrap(async (req, res) => {
    const [dues, ps, payments, recent] = await Promise.all([
      duesFor(req.user.id), paymentSettings(),
      db.q('SELECT id, amount, utr, status, created_at, reviewed_at, note FROM commission_payments WHERE driver_id = $1 ORDER BY id DESC LIMIT 20', [req.user.id]),
      db.q("SELECT id, vehicle, fare, commission, platform_fee, tier, completed_at FROM rides WHERE driver_id = $1 AND status = 'completed' ORDER BY id DESC LIMIT 20", [req.user.id]),
    ]);
    res.json({ ...dues, upiId: ps.upiId, payeeName: ps.payeeName, duesLimit: ps.duesLimit,
      payments: payments.map(p => ({ id: p.id, amount: p.amount, utr: p.utr, status: p.status, createdAt: p.created_at, reviewedAt: p.reviewed_at, note: p.note })),
      rides: recent.map(r => ({ id: r.id, vehicle: r.vehicle, fare: r.fare, commission: r.commission, platformFee: r.platform_fee, tier: r.tier, completedAt: r.completed_at })) });
  }));

  // ---------------- rider plans: Tier 1 pay-per-ride (default), Tier 2 half-day pass, Tier 3 full-day pass
  async function planView(driverId) {
    const P = await pricing(), t = now();
    const pass = await activePass(driverId, t);
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const today = await db.one(`SELECT COUNT(*) AS rides, COALESCE(SUM(fare - platform_fee), 0) AS kept, COALESCE(SUM(commission), 0) AS ride_fees
      FROM rides WHERE driver_id = $1 AND status = 'completed' AND completed_at >= $2`, [driverId, day.getTime()]);
    // SafeShe's share per ride comes only from Admin → Fares: platform fee + minimum amount, per vehicle.
    const shares = (await fares()).filter(f => f.active).map(f => ({ vehicle: f.vehicle, name: f.name, platformFee: f.platform_fee || 0, minimum: f.min_fare || 0 }));
    return { tiers: P.tiers, shares, active: pass ? { kind: pass.kind, name: P.tiers[pass.kind].name, price: pass.price, startsAt: pass.starts_at, endsAt: pass.ends_at } : null,
      current: pass ? pass.kind : 'perRide', today: { rides: today.rides, kept: round2(today.kept), rideFees: round2(today.ride_fees) } };
  }
  app.get('/api/driver/plan', auth('driver'), wrap(async (req, res) => res.json(await planView(req.user.id))));
  app.post('/api/driver/pass', auth('driver'), wrap(async (req, res) => {
    await requireApproved(req.user);
    const kind = req.body.kind;
    if (kind !== 'half' && kind !== 'full') throw httpError(400, 'Choose the Half-Day or Full-Day pass.');
    const P = await pricing(), t = now();
    const cur = await activePass(req.user.id, t);
    if (cur) throw httpError(409, `You already have an active ${P.tiers[cur.kind].name} until ${new Date(cur.ends_at).toLocaleString('en-IN', { timeZone: P.night.timeZone, hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}.`);
    const tier = P.tiers[kind];
    await db.exec('INSERT INTO driver_passes (driver_id, kind, price, starts_at, ends_at, created_at) VALUES ($1,$2,$3,$4,$5,$4)',
      [req.user.id, kind, tier.price, t, t + tier.hours * 3600_000]);
    log(`[rider ${req.user.id}] bought ${kind} pass ₹${tier.price}`);
    await emit('admins', 'admin:pass', { driverId: req.user.id, name: req.user.name, kind, price: tier.price });
    res.json(await planView(req.user.id));
  }));
  app.get('/api/pricing', wrap(async (req, res) => {
    const P = await pricing();
    res.json({ night: P.night, nightNow: pricingEngine.isNight(now(), P), pickup: P.pickup, gridlock: P.gridlock,
      fares: (await fares()).filter(f => f.active).map(f => ({ vehicle: f.vehicle, name: f.name, base: f.base, includedKm: f.included_km, perKm: f.per_km, perMin: f.per_min, platformFee: f.platform_fee, minFare: f.min_fare })) });
  }));
  app.post('/api/driver/payments', auth('driver'), wrap(async (req, res) => {
    const amount = num(req.body.amount, 1, 100000);
    const utr = str(req.body.utr, 40).replace(/\s+/g, '').toUpperCase();
    if (!amount) throw httpError(400, 'Enter the amount you paid.');
    if (!/^[A-Z0-9]{6,35}$/.test(utr)) throw httpError(400, 'Enter the UPI transaction reference (UTR / UPI Ref No.), usually 12 digits, from your UPI app.');
    if (await db.one('SELECT 1 AS x FROM commission_payments WHERE UPPER(utr) = $1', [utr])) throw httpError(409, 'This UPI reference was already submitted.');
    let rideId = null; // optional: SafeShe's share for one specific ride
    if (req.body.rideId) {
      const r = await db.one("SELECT id FROM rides WHERE id = $1 AND driver_id = $2 AND status = 'completed'", [+req.body.rideId || 0, req.user.id]);
      if (!r) throw httpError(404, 'Ride not found.'); rideId = r.id;
    }
    const p = await db.one('INSERT INTO commission_payments (driver_id, amount, utr, created_at, ride_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [req.user.id, round2(amount), utr, now(), rideId]);
    log(`[payment ${p.id}] rider ${req.user.id} reported ₹${amount} (UTR ${utr})`);
    await emit('admins', 'admin:payment', { id: p.id, driverId: req.user.id, name: req.user.name, amount: round2(amount) });
    // The admin's bank alert may have arrived first: confirm straight away when UTR and amount match.
    const alert = await db.one('SELECT * FROM bank_alerts WHERE utr = $1', [utr]);
    const autoVerified = !!(alert && await matchAlert(alert));
    res.json({ ok: true, id: p.id, autoVerified, dues: await duesFor(req.user.id) });
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
      (SELECT COALESCE(SUM(commission + platform_fee), 0) FROM rides WHERE status = 'completed' AND completed_at >= $1)
        + (SELECT COALESCE(SUM(price), 0) FROM driver_passes WHERE created_at >= $1) AS commission_today,
      (SELECT COALESCE(SUM(platform_fee), 0) FROM rides WHERE status = 'completed' AND completed_at >= $1) AS platform_fees_today,
      (SELECT COALESCE(SUM(commission), 0) FROM rides WHERE status = 'completed' AND completed_at >= $1) AS ride_fees_today,
      (SELECT COUNT(*) FROM driver_passes WHERE created_at >= $1) AS passes_today,
      (SELECT COALESCE(SUM(price), 0) FROM driver_passes WHERE created_at >= $1) AS pass_revenue_today,
      (SELECT COALESCE(SUM(commission + platform_fee), 0) FROM rides WHERE status = 'completed') + (SELECT COALESCE(SUM(price), 0) FROM driver_passes)
        - (SELECT COALESCE(SUM(amount), 0) FROM commission_payments WHERE status = 'confirmed') AS commission_due,
      (SELECT COUNT(*) FROM commission_payments WHERE status = 'pending') AS payments_pending`, [d0]);
    res.json({ passengers: s.passengers, riders: s.riders, ridersOnline: (await availableDrivers()).length, ridersPending: s.riders_pending,
      activeRides: s.active_rides, ridesToday: s.rides_today, completedToday: s.completed_today, revenueToday: s.revenue_today, openSos: s.open_sos, otpTestMode: await otp.isTestMode(),
      commissionToday: round2(s.commission_today), platformFeesToday: round2(s.platform_fees_today), rideFeesToday: round2(s.ride_fees_today),
      passesToday: s.passes_today, passRevenueToday: round2(s.pass_revenue_today),
      commissionDue: round2(Math.max(0, s.commission_due)), paymentsPending: s.payments_pending });
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
      const vals = [num(f.base, 0, 10000), num(f.per_km, 0, 1000), num(f.per_min, 0, 1000), num(f.min_fare == null ? 0 : f.min_fare, 0, 10000),
        num(f.included_km == null ? 0 : f.included_km, 0, 50), num(f.platform_fee == null ? 0 : f.platform_fee, 0, 1000)];
      if (vals.some(v => v == null)) throw httpError(400, `Invalid fare values for ${f.vehicle}.`);
      await db.exec('UPDATE fares SET name=$1, base=$2, per_km=$3, per_min=$4, min_fare=$5, included_km=$6, platform_fee=$7, active=$8 WHERE vehicle=$9',
        [str(f.name, 30) || f.vehicle, ...vals, !!f.active, f.vehicle]);
    }
    log('[admin] fares updated');
    res.json({ fares: await fares() });
  }));
  // ---------------- admin: reports (7 days, 90 days or custom range, India time) as JSON preview or PDF
  app.get('/api/admin/report', admin, wrap(async (req, res) => {
    const range = reports.resolveRange(req.query);
    res.json(await reports.buildReport(db, range));
  }));
  app.get('/api/admin/report.pdf', admin, wrap(async (req, res) => {
    const range = reports.resolveRange(req.query);
    const pdf = await reports.renderPdf(await reports.buildReport(db, range));
    const name = `SafeShe-report-${range.from}-to-${range.to}.pdf`;
    log(`[admin] report ${range.from}..${range.to} downloaded (${pdf.length} bytes)`);
    res.set('Content-Type', 'application/pdf').set('Content-Disposition', `attachment; filename="${name}"`).set('X-Filename', name)
      .set('Access-Control-Expose-Headers', 'X-Filename, Content-Disposition').send(pdf);
  }));

  // ---------------- admin: service regions (reachable / not reachable)
  function regionInput(b) {
    const name = str(b.name, 60), state = str(b.state, 60);
    const lat = num(b.lat, 6, 38), lng = num(b.lng, 68, 98), radius = num(b.radiusKm, 1, 200); // India bounds
    if (name.length < 2) throw httpError(400, 'Enter the region name.');
    if (lat == null || lng == null) throw httpError(400, 'Set the region centre (a location in India). Use "Find" to look up the city.');
    if (radius == null) throw httpError(400, 'Radius must be 1–200 km.');
    return [name, state, lat, lng, radius, b.active !== false];
  }
  app.get('/api/admin/regions', admin, wrap(async (req, res) => {
    const regs = await regionsAll();
    const counts = await db.q("SELECT pickup_lat AS lat, pickup_lng AS lng FROM rides WHERE status = 'completed' AND completed_at > $1", [now() - 30 * 24 * 3600_000]);
    res.json({ regions: regs.map(r => ({ ...regionView(r), rides30d: counts.filter(c => haversineKm(r, c) <= r.radius_km).length })) });
  }));
  app.post('/api/admin/regions', admin, wrap(async (req, res) => {
    const v = regionInput(req.body);
    const r = await db.one('INSERT INTO regions (name, state, lat, lng, radius_km, active, sort, created_at) VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(sort),0)+1 FROM regions),$7) ON CONFLICT DO NOTHING RETURNING *', [...v, now()]);
    if (!r) throw httpError(409, 'A region with this name already exists.');
    log(`[admin] region added: ${r.name}`);
    res.json({ region: regionView(r) });
  }));
  app.put('/api/admin/regions/:id', admin, wrap(async (req, res) => {
    const cur = await db.one('SELECT * FROM regions WHERE id = $1', [+req.params.id || 0]);
    if (!cur) throw httpError(404, 'Region not found.');
    const v = regionInput({ name: cur.name, state: cur.state, lat: cur.lat, lng: cur.lng, radiusKm: cur.radius_km, active: cur.active, ...req.body });
    const r = await db.one('UPDATE regions SET name=$1, state=$2, lat=$3, lng=$4, radius_km=$5, active=$6 WHERE id=$7 RETURNING *', [...v, cur.id]).catch(e => {
      if (/unique/i.test(e.message)) throw httpError(409, 'A region with this name already exists.'); throw e; });
    log(`[admin] region ${r.name} updated (${r.active ? 'reachable' : 'not reachable'})`);
    res.json({ region: regionView(r) });
  }));
  app.delete('/api/admin/regions/:id', admin, wrap(async (req, res) => {
    const n = await db.exec('DELETE FROM regions WHERE id = $1', [+req.params.id || 0]);
    if (!n) throw httpError(404, 'Region not found.');
    res.json({ ok: true });
  }));
  app.get('/api/admin/pricing', admin, wrap(async (req, res) => res.json(await pricing())));
  app.put('/api/admin/pricing', admin, wrap(async (req, res) => {
    const v = pricingEngine.validatePricing(req.body);
    await db.exec("INSERT INTO kv (key, value) VALUES ('pricing', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(v)]);
    log('[admin] pricing settings updated');
    res.json(v);
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
        COALESCE((SELECT SUM(commission + platform_fee) FROM rides r WHERE r.driver_id = u.id AND r.status = 'completed'), 0)
          + COALESCE((SELECT SUM(price) FROM driver_passes x WHERE x.driver_id = u.id), 0) AS charged,
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
    if (!await reviewPayment(+req.params.id || 0, st, str(req.body.note, 300) || null)) throw httpError(404, 'Payment not found or already reviewed.');
    log(`[admin] payment ${req.params.id} ${st}`);
    res.json({ ok: true });
  }));
  async function reviewPayment(id, st, note) {
    const p = await db.one("UPDATE commission_payments SET status = $1, reviewed_at = $2, note = $3 WHERE id = $4 AND status = 'pending' RETURNING driver_id, amount", [st, now(), note, id]);
    if (p) await emit('user:' + p.driver_id, 'payment:update', { id, status: st, amount: p.amount, auto: /^Auto-verified/.test(note || '') });
    return p;
  }

  // ---------------- automatic payment verification from the admin's bank "money received" SMS
  // The SafeShe app on the admin's phone forwards bank credit alerts (or the admin pastes one). Only the amount,
  // UPI reference and sender UPI ID are kept. A pending rider payment is confirmed when the UTR and amount match.
  async function matchAlert(alert) {
    if (alert.payment_id) return null;
    const p = await db.one("SELECT id, amount FROM commission_payments WHERE UPPER(utr) = $1 AND status = 'pending'", [alert.utr]);
    if (!p || Math.abs(p.amount - alert.amount) > 0.009) return null;
    if (!await db.exec('UPDATE bank_alerts SET payment_id = $1 WHERE id = $2 AND payment_id IS NULL', [p.id, alert.id])) return null;
    await reviewPayment(p.id, 'confirmed', `Auto-verified from bank alert (UTR ${alert.utr}, ₹${alert.amount})`);
    log(`[payment ${p.id}] auto-verified from bank alert`);
    await emit('admins', 'admin:payment-auto', { id: p.id, amount: alert.amount, utr: alert.utr });
    return p.id;
  }
  app.post('/api/admin/bank-alerts', admin, wrap(async (req, res) => {
    const parsed = parseBankSms(str(req.body.text, 1000));
    if (!parsed) return res.json({ ok: true, credit: false, message: 'Not a UPI money-received message (needs "credited/received", an amount and a 12-digit UPI reference).' });
    const at = num(req.body.at, 0, 1e15) || now();
    await db.exec('INSERT INTO bank_alerts (utr, amount, vpa, source, received_at, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (utr) DO NOTHING',
      [parsed.utr, parsed.amount, parsed.vpa, str(req.body.source, 20) || 'manual', at, now()]);
    const alert = await db.one('SELECT * FROM bank_alerts WHERE utr = $1', [parsed.utr]);
    const paymentId = await matchAlert(alert);
    res.json({ ok: true, credit: true, alert: { utr: parsed.utr, amount: parsed.amount, vpa: parsed.vpa }, matchedPaymentId: paymentId || alert.payment_id || null });
  }));
  app.get('/api/admin/bank-alerts', admin, wrap(async (req, res) => {
    const rows = await db.q('SELECT a.*, u.name FROM bank_alerts a LEFT JOIN commission_payments p ON p.id = a.payment_id LEFT JOIN users u ON u.id = p.driver_id ORDER BY a.id DESC LIMIT 50');
    res.json({ alerts: rows.map(a => ({ id: a.id, utr: a.utr, amount: a.amount, vpa: a.vpa, source: a.source, receivedAt: a.received_at, paymentId: a.payment_id, rider: a.name || null })) });
  }));
  // TEMPORARY: compare place-search request variants from this server (admin only).
  app.get('/api/admin/geo-bench', admin, wrap(async (req, res) => {
    const q = encodeURIComponent(String(req.query.q || 'brigade road')), out = {};
    const urls = {
      bboxBias: `https://photon.komoot.io/api/?limit=15&lang=en&q=${q}&bbox=77.3,12.7,77.9,13.2&lat=12.97&lon=77.59&zoom=12&location_bias_scale=0.3`,
      bboxOnly: `https://photon.komoot.io/api/?limit=8&q=${q}&bbox=77.3,12.7,77.9,13.2`,
      biasOnly: `https://photon.komoot.io/api/?limit=8&q=${q}&lat=12.97&lon=77.59`,
      plain: `https://photon.komoot.io/api/?limit=8&q=${q}`,
      nominatim: `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${q}&viewbox=77.3,13.2,77.9,12.7&bounded=1`,
    };
    for (const [k, u] of Object.entries(urls)) {
      const t = Date.now();
      try { const r = await fetch(u, { headers: { 'User-Agent': 'SafeShe-Rides/1.0' }, signal: AbortSignal.timeout(10000) }); const j = await r.json(); out[k] = { ms: Date.now() - t, status: r.status, n: (j.features || j).length }; }
      catch (e) { out[k] = { ms: Date.now() - t, error: e.message }; }
    }
    res.json({ region: process.env.VERCEL_REGION || null, out });
  }));
  app.get('/api/admin/otps', admin, wrap(async (req, res) => res.json({ testMode: await otp.isTestMode(), codes: await otp.recentTestCodes() })));
  // Admin can enter the 2Factor API key here (checked with 2Factor, stored in the database, shown only masked).
  app.put('/api/admin/sms-key', admin, wrap(async (req, res) => {
    const st = await otp.saveKey(req.body && req.body.key);
    res.json(st);
  }));
  app.get('/api/admin/sms-status', admin, wrap(async (req, res) => res.json(await otp.smsStatus({ quick: req.query.quick === '1' }))));
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
    res.status(status).json({ error: status >= 500 && !err.status ? (/DATABASE_URL/.test(err.message) ? err.message : 'Something went wrong. Please try again.') : err.message,
      code: err.status && typeof err.code === 'string' ? err.code : undefined });
  });

  return { app, db, cfg, init, tick, close: () => db.close() };
}

module.exports = { createApp, loadConfig };
