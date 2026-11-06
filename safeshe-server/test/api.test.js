'use strict';
// End-to-end API test: passenger + rider + admin, with live events via /api/events polling.
// Needs a Postgres database: TEST_DATABASE_URL (the test wipes and recreates its schema).
// Map services are not required (route falls back to an estimate).
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const { createApp, loadConfig } = require('../src/app');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('Set TEST_DATABASE_URL to a throwaway Postgres database (its tables are dropped).'); process.exit(2); }

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' → ' + e.message]); }
}

(async () => {
  const wipe = new Pool({ connectionString: DB });
  await wipe.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await wipe.end();

  const cfg = loadConfig({ DATABASE_URL: DB, ADMIN_PASSWORD: 'test-admin-pass', ADMIN_EMAIL: 'Owner.Test@Example.com', OTP_SHOW_IN_APP: '1', QUIET: '1',
    NOMINATIM_URL: 'http://127.0.0.1:9', PHOTON_URL: 'http://127.0.0.1:9', OSRM_URL: 'http://127.0.0.1:9', SEARCH_TIMEOUT_SEC: '60' });
  const S = createApp(cfg);
  const server = http.createServer(S.app);
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;

  async function api(method, p, body, token) {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { ...j, status: r.status, data: j };
  }
  // Event stream per token (mirrors the app's poller).
  const cursors = {};
  async function events(token) {
    if (cursors[token] == null) cursors[token] = (await api('GET', '/api/events', null, token)).cursor;
    const r = await api('GET', '/api/events?after=' + cursors[token], null, token);
    cursors[token] = r.cursor; return r.events;
  }
  async function waitFor(token, type, pred = () => true, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const e of await events(token)) if (e.type === type && pred(e.data)) return e.data;
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('timeout waiting for ' + type);
  }
  async function login(phone, role) {
    const s = await api('POST', '/api/auth/otp/send', { phone, role });
    assert.equal(s.status, 200, s.error); assert.match(s.devCode, /^\d{6}$/);
    const v = await api('POST', '/api/auth/otp/verify', { phone, role, code: s.devCode });
    assert.equal(v.status, 200, v.error); assert.ok(v.token);
    return v;
  }

  const BLR = { lat: 12.9716, lng: 77.5946 }, KORA = { lat: 12.9352, lng: 77.6245, name: 'Koramangala' };
  let P, D, D2, A, ride;

  await step('health + database ready', async () => { const h = await api('GET', '/api/health'); assert.equal(h.ok, true); assert.equal(h.otpTestMode, true); });
  await step('invalid phone rejected', async () => { assert.equal((await api('POST', '/api/auth/otp/send', { phone: '12345', role: 'passenger' })).status, 400); });
  await step('wrong OTP rejected', async () => {
    await api('POST', '/api/auth/otp/send', { phone: '9000000099', role: 'passenger' });
    assert.equal((await api('POST', '/api/auth/otp/verify', { phone: '9000000099', role: 'passenger', code: '000000' })).status, 400);
  });
  await step('OTP resend throttled (30 s)', async () => { assert.equal((await api('POST', '/api/auth/otp/send', { phone: '9000000099', role: 'passenger' })).status, 429); });
  await step('OTP is single-use', async () => {
    const s = await api('POST', '/api/auth/otp/send', { phone: '9000000098', role: 'passenger' });
    assert.equal((await api('POST', '/api/auth/otp/verify', { phone: '9000000098', role: 'passenger', code: s.devCode })).status, 200);
    assert.equal((await api('POST', '/api/auth/otp/verify', { phone: '9000000098', role: 'passenger', code: s.devCode })).status, 400);
  });
  await step('passenger login + profile', async () => {
    P = await login('9876500001', 'passenger');
    assert.equal(P.user.phone, '+919876500001');
    const r = await api('PUT', '/api/me', { name: 'Asha Rao', gender: 'female', emergencyPhone: '9876500009' }, P.token);
    assert.equal(r.user.name, 'Asha Rao'); assert.equal(r.user.emergencyPhone, '+919876500009');
  });
  await step('rider login + vehicle profile → pending', async () => {
    D = await login('9876500002', 'driver');
    await api('PUT', '/api/me', { name: 'Priya Sharma', gender: 'female' }, D.token);
    const r = await api('POST', '/api/driver/profile', { vehicleType: 'cab', vehicleModel: 'Tata Tigor EV', plate: 'KA 01 AB 1234', licenseNo: 'KA0120230001234' }, D.token);
    assert.equal(r.user.driver.status, 'pending');
    assert.equal((await api('POST', '/api/driver/online', { online: true, ...BLR }, D.token)).status, 403);
  });
  await step('admin wrong password rejected', async () => { assert.equal((await api('POST', '/api/admin/login', { username: 'Administrator', password: 'nope' })).status, 401); });
  await step('no "too many requests" for normal use: 15 correct admin logins in a row', async () => {
    for (let i = 0; i < 15; i++) assert.ok((await api('POST', '/api/admin/login', { username: 'Administrator', password: 'test-admin-pass' })).token, 'login ' + (i + 1));
    assert.equal((await api('POST', '/api/admin/login', { username: 'Administrator', password: 'nope' })).status, 401, 'wrong password is 401, not 429');
  });
  await step('admin login + approve rider (live event to rider)', async () => {
    A = await api('POST', '/api/admin/login', { username: 'Administrator', password: 'test-admin-pass' });
    assert.ok(A.token);
    await events(D.token); await events(A.token);
    assert.equal((await api('GET', '/api/admin/riders?status=pending', null, A.token)).riders.length, 1);
    await api('POST', `/api/admin/riders/${D.user.id}/approve`, {}, A.token);
    assert.equal((await waitFor(D.token, 'driver:status')).status, 'approved');
  });
  await step('passenger cannot use admin API; rider cannot book', async () => {
    assert.equal((await api('GET', '/api/admin/stats', null, P.token)).status, 403);
    assert.equal((await api('POST', '/api/rides/quote', { pickup: BLR, drop: KORA }, D.token)).status, 403);
  });
  await step('rider goes online', async () => { const r = await api('POST', '/api/driver/online', { online: true, lat: 12.975, lng: 77.6 }, D.token); assert.equal(r.status, 200, r.error); });
  await step('quote shows fares and nearby riders', async () => {
    const q = await api('POST', '/api/rides/quote', { pickup: BLR, drop: KORA }, P.token);
    assert.equal(q.status, 200, q.error); assert.ok(q.km > 4 && q.km < 10, 'km ' + q.km);
    const by = v => q.options.find(o => o.vehicle === v);
    assert.equal(by('cab').ridersNearby, 1); assert.equal(by('pink').ridersNearby, 1); assert.equal(by('bike').ridersNearby, 0);
  });
  await step('book Pink Cab → offer reaches female cab rider', async () => {
    await events(P.token);
    const r = await api('POST', '/api/rides', { pickup: { ...BLR, name: 'MG Road' }, drop: KORA, vehicle: 'pink', payment: 'upi' }, P.token);
    assert.equal(r.status, 200, r.error); ride = r.ride;
    assert.equal(ride.status, 'requested'); assert.match(ride.otp, /^\d{4}$/); assert.ok(ride.shareUrl.includes('/t/'));
    const o = await waitFor(D.token, 'ride:offer'); assert.equal(o.rideId, ride.id); assert.equal(o.fare, ride.fare); assert.equal(o.otp, undefined);
  });
  await step('second booking blocked while active', async () => { assert.equal((await api('POST', '/api/rides', { pickup: BLR, drop: KORA, vehicle: 'cab' }, P.token)).status, 409); });
  await step('rider accepts → passenger gets live update with rider details', async () => {
    const a = await api('POST', `/api/rides/${ride.id}/accept`, {}, D.token);
    assert.equal(a.status, 200, a.error); assert.equal(a.ride.otp, undefined);
    const u = await waitFor(P.token, 'ride:update', r => r.status === 'accepted');
    assert.equal(u.driver.name, 'Priya Sharma'); assert.equal(u.driver.plate, 'KA 01 AB 1234');
  });
  await step('second rider cannot take the same ride (parallel accept race)', async () => {
    D2 = await login('9876500003', 'driver');
    await api('PUT', '/api/me', { name: 'Kiran', gender: 'female' }, D2.token);
    await api('POST', '/api/driver/profile', { vehicleType: 'cab', vehicleModel: 'Dzire', plate: 'KA 02 CD 5678', licenseNo: 'KA0220230005678' }, D2.token);
    await api('POST', `/api/admin/riders/${D2.user.id}/approve`, {}, A.token);
    await api('POST', '/api/driver/online', { online: true, lat: 12.97, lng: 77.59 }, D2.token);
    assert.equal((await api('POST', `/api/rides/${ride.id}/accept`, {}, D2.token)).status, 409);
  });
  await step('rider location streams to passenger', async () => {
    await api('POST', '/api/driver/location', { lat: 12.973, lng: 77.597 }, D.token);
    const l = await waitFor(P.token, 'ride:driver_location'); assert.equal(l.rideId, ride.id); assert.equal(l.lat, 12.973);
  });
  await step('public tracking link works without login', async () => {
    const t = await api('GET', '/api/track/' + ride.shareToken);
    assert.equal(t.status, 200); assert.equal(t.data.status, 'accepted'); assert.equal(t.driver.plate, 'KA 01 AB 1234'); assert.equal(t.driver.lat, 12.973);
    assert.equal(t.driver.phone, undefined); assert.equal(t.otp, undefined);
  });
  await step('SOS reaches admin live', async () => {
    assert.equal((await api('POST', '/api/sos', { lat: 12.973, lng: 77.597, accuracy: 8, message: 'help test' }, P.token)).status, 200);
    const s = await waitFor(A.token, 'admin:sos'); assert.equal(s.ride.id, ride.id); assert.equal(s.user.phone, '+919876500001');
    assert.equal((await api('POST', `/api/admin/sos/${s.id}/resolve`, { note: 'called user' }, A.token)).status, 200);
  });
  await step('rider marks arrived; wrong pickup OTP refused', async () => {
    assert.equal((await api('POST', `/api/rides/${ride.id}/arrived`, {}, D.token)).ride.status, 'arrived');
    await waitFor(P.token, 'ride:update', r => r.status === 'arrived');
    assert.equal((await api('POST', `/api/rides/${ride.id}/start`, { otp: ride.otp === '0000' ? '1111' : '0000' }, D.token)).status, 400);
  });
  await step('ride lifecycle: OTP start → complete → rate', async () => {
    const st = await api('POST', `/api/rides/${ride.id}/start`, { otp: ride.otp }, D.token);
    assert.equal(st.status, 200, st.error); assert.equal(st.ride.status, 'started');
    assert.equal((await api('POST', `/api/rides/${ride.id}/cancel`, {}, P.token)).status, 409, 'started ride cannot be cancelled');
    assert.equal((await api('POST', `/api/rides/${ride.id}/complete`, {}, D.token)).ride.status, 'completed');
    await waitFor(P.token, 'ride:update', r => r.status === 'completed');
    assert.equal((await api('POST', `/api/rides/${ride.id}/rate`, { stars: 5 }, P.token)).status, 200);
    assert.equal((await api('POST', `/api/rides/${ride.id}/rate`, { stars: 1 }, P.token)).status, 409, 'rate only once');
    assert.equal((await api('GET', '/api/me', null, D.token)).user.driver.rating, 5);
  });
  await step('history for passenger and rider', async () => {
    assert.equal((await api('GET', '/api/rides/history', null, P.token)).rides[0].status, 'completed');
    assert.equal((await api('GET', '/api/rides/history', null, D.token)).rides[0].fare, ride.fare);
  });
  await step('rider plan: pay-per-ride ₹3 tier fee (+ platform fee) charged on completion', async () => {
    const h = await api('GET', '/api/rides/history', null, D.token);
    assert.equal(h.rides[0].tier, 'perRide'); assert.equal(h.rides[0].commission, 3); assert.equal(h.rides[0].platformFee, 0, 'pink cab has no platform fee by default');
    assert.equal((await api('GET', '/api/rides/history', null, P.token)).rides[0].commission, undefined, 'passengers do not see rider fees');
    const d = await api('GET', '/api/driver/dues', null, D.token);
    assert.equal(d.charged, 3); assert.equal(d.rideFees, 3); assert.equal(d.due, 3); assert.equal(d.toPay, 3); assert.equal(d.upiId, '');
  });
  await step('dues: admin UPI settings, dues limit blocks going online', async () => {
    assert.equal((await api('PUT', '/api/admin/payment-settings', { upiId: 'not a upi', payeeName: 'SafeShe' }, A.token)).status, 400);
    const s = await api('PUT', '/api/admin/payment-settings', { upiId: 'safeshe.admin@okaxis', payeeName: 'SafeShe Rides', duesLimit: 2 }, A.token);
    assert.equal(s.upiId, 'safeshe.admin@okaxis'); assert.equal(s.duesLimit, 2);
    const on = await api('POST', '/api/driver/online', { online: true, lat: 12.975, lng: 77.6 }, D.token);
    assert.equal(on.status, 402); assert.match(on.error, /₹3/);
    assert.equal((await api('PUT', '/api/admin/payment-settings', { upiId: 'x@y' }, P.token)).status, 403, 'only admin');
  });
  await step('dues: rider reports UPI payment → admin confirms → dues cleared', async () => {
    assert.equal((await api('POST', '/api/driver/payments', { amount: 3, utr: '12' }, D.token)).status, 400, 'bad UTR');
    const p = await api('POST', '/api/driver/payments', { amount: 3, utr: '4123 4567 8901' }, D.token);
    assert.equal(p.status, 200, p.error); assert.equal(p.dues.pending, 3); assert.equal(p.dues.toPay, 0);
    assert.equal((await api('POST', '/api/driver/payments', { amount: 3, utr: '412345678901' }, D.token)).status, 409, 'same UTR twice');
    assert.equal((await waitFor(A.token, 'admin:payment')).amount, 3);
    assert.equal((await api('POST', '/api/driver/online', { online: true, lat: 12.975, lng: 77.6 }, D.token)).status, 200, 'pending payment unblocks');
    const list = await api('GET', '/api/admin/payments?status=pending', null, A.token);
    assert.equal(list.payments.length, 1);
    assert.equal((await api('POST', `/api/admin/payments/${list.payments[0].id}/confirm`, {}, A.token)).status, 200);
    assert.equal((await waitFor(D.token, 'payment:update')).status, 'confirmed');
    const d = await api('GET', '/api/driver/dues', null, D.token); assert.equal(d.paid, 3); assert.equal(d.due, 0);
    assert.equal((await api('POST', `/api/admin/payments/${list.payments[0].id}/confirm`, {}, A.token)).status, 404, 'cannot confirm twice');
    await api('PUT', '/api/admin/payment-settings', { upiId: 'safeshe.admin@okaxis', payeeName: 'SafeShe Rides', duesLimit: 0 }, A.token);
  });
  await step('pricing engine: rate cards, night 1.25×, pickup surcharge, gridlock trigger (pure)', async () => {
    const PE = require('../src/pricing'), cfgP = PE.normalizePricing({});
    const bike = { base: 20, included_km: 2, per_km: 7, per_min: 0.5, platform_fee: 2, min_fare: 0 };
    const auto = { base: 30, included_km: 1.5, per_km: 11, per_min: 0.75, platform_fee: 3, min_fare: 0 };
    assert.equal(PE.computeFare(bike, { km: 1.5 }, cfgP).total, 22, 'within first 2 km: base + fee');
    assert.equal(PE.computeFare(bike, { km: 5 }, cfgP).total, 43, '20 + 3×7 + 2');
    assert.equal(PE.computeFare(auto, { km: 4 }, cfgP).total, 61, '30 + 2.5×11 + 3 = 60.5 → 61');
    assert.equal(PE.computeFare(auto, { km: 4, night: true }, cfgP).total, 75, '(30 + 27.5) × 1.25 + 3');
    assert.equal(PE.computeFare(bike, { km: 5, trafficMin: 10 }, cfgP).total, 48, '+10 gridlock min × ₹0.50');
    assert.equal(PE.pickupSurcharge(2.5, cfgP), 0); assert.equal(PE.pickupSurcharge(4, cfgP), 2.25);
    const IST = h => Date.UTC(2026, 10, 6, h, 0) - 5.5 * 3600e3;
    assert.deepEqual([IST(22), IST(23), IST(2), IST(5)].map(t => PE.isNight(t, cfgP)), [false, true, true, false]);
    const kmFn = (a, b) => require('../src/geo').haversineKm(a, b);
    const sim = speeds => { let st = null, t = 0, lat = 12.97; for (const v of speeds) { t += 30000; lat += v * (30 / 3600) / 111; st = PE.trackGridlock(st, { lat, lng: 77.59 }, t, cfgP, kmFn); } return st.sec / 60; };
    assert.equal(sim(Array(21).fill(30)), 0, 'open road: no time charge');
    assert.equal(sim([30, 5, 5, 5, 5, 5, 30]), 0, 'slow 2.5 min: below the 3-minute trigger');
    assert.equal(sim([30, ...Array(12).fill(3), 30]), 6, 'gridlock 6 min: all 6 minutes billed');
    assert.throws(() => PE.validatePricing({ night: { multiplier: 9 } }), /multiplier/);
  });
  await step('pricing: quote uses the rate card; bike/auto show breakdown with platform fee', async () => {
    const q = await api('POST', '/api/rides/quote', { pickup: BLR, drop: KORA }, P.token);
    const bike = q.options.find(o => o.vehicle === 'bike'), auto = q.options.find(o => o.vehicle === 'auto');
    const PE = require('../src/pricing');
    assert.equal(bike.breakdown.platformFee, 2); assert.equal(auto.breakdown.platformFee, 3);
    assert.equal(bike.breakdown.includedKm, 2); assert.equal(auto.breakdown.includedKm, 1.5);
    assert.equal(bike.breakdown.traffic, 0, 'upfront fare has no time charge (gridlock only)');
    const expected = PE.computeFare({ base: 20, included_km: 2, per_km: 7, per_min: 0.5, platform_fee: 2 }, { km: q.km, night: q.night }, PE.normalizePricing({})).total;
    assert.ok(Math.abs(bike.fare - expected) <= 1, `bike ${bike.fare} vs ${expected}`);
    assert.equal(q.night, PE.isNight(Date.now(), PE.normalizePricing({})));
  });
  // Full ride helper for rider D (female cab rider)
  async function fullRide(pickup, vehicle, beforeComplete) {
    const r = await api('POST', '/api/rides', { pickup: { ...pickup, name: 'Pickup' }, drop: KORA, vehicle }, P.token);
    assert.equal(r.status, 200, r.error);
    const a = await api('POST', `/api/rides/${r.ride.id}/accept`, {}, D.token); assert.equal(a.status, 200, a.error);
    await api('POST', `/api/rides/${r.ride.id}/arrived`, {}, D.token);
    assert.equal((await api('POST', `/api/rides/${r.ride.id}/start`, { otp: r.ride.otp }, D.token)).status, 200);
    if (beforeComplete) await beforeComplete(r.ride.id);
    const c = await api('POST', `/api/rides/${r.ride.id}/complete`, {}, D.token); assert.equal(c.status, 200, c.error);
    return { booked: r.ride, accepted: a.ride, done: c.ride };
  }
  await step('pricing: long pickup surcharge (rider 4 km away) + gridlock minutes added to the final fare', async () => {
    await api('POST', '/api/driver/online', { online: true, lat: 12.975, lng: 77.6 }, D.token);
    const far = { lat: 12.975 - 0.036, lng: 77.6 }; // ≈4 km south of the rider
    const x = await fullRide(far, 'pink', async id => {
      // Simulate 6 minutes of gridlock recorded from GPS (the tracker itself is tested above).
      await S.db.exec('UPDATE rides SET gridlock = $1 WHERE id = $2', [JSON.stringify({ sec: 360 }), id]);
    });
    assert.ok(x.accepted.pickupSurcharge > 2 && x.accepted.pickupSurcharge < 2.6, 'surcharge ' + x.accepted.pickupSurcharge);
    assert.equal(x.accepted.fare, Math.round(x.booked.fare + x.accepted.pickupSurcharge), 'fare updated at accept');
    assert.equal(x.done.trafficMin, 6);
    const cabPerMin = 1.5, mult = x.booked.night ? 1.25 : 1;
    assert.equal(x.done.fare, Math.round(x.booked.upfrontFare + x.accepted.pickupSurcharge + 6 * cabPerMin * mult), 'final = upfront + pickup + traffic');
    assert.equal(x.done.driverKeeps, x.done.fare, 'pink cab: no platform fee → rider keeps the whole fare incl. 100% of the surcharge');
  });
  await step('rider tiers: half-day pass ₹15 → rides during the pass have no per-ride fee', async () => {
    const before = await api('GET', '/api/driver/dues', null, D.token);
    const plan0 = await api('GET', '/api/driver/plan', null, D.token);
    assert.equal(plan0.current, 'perRide'); assert.equal(plan0.tiers.half.price, 15); assert.equal(plan0.tiers.full.price, 29); assert.equal(plan0.tiers.perRide.fee, 3);
    const buy = await api('POST', '/api/driver/pass', { kind: 'half' }, D.token);
    assert.equal(buy.status, 200, buy.error); assert.equal(buy.active.kind, 'half'); assert.ok(buy.active.endsAt - buy.active.startsAt === 6 * 3600e3);
    assert.equal((await api('POST', '/api/driver/pass', { kind: 'full' }, D.token)).status, 409, 'one pass at a time');
    const x = await fullRide({ lat: 12.9716, lng: 77.5946 }, 'cab');
    assert.equal(x.done.tier, 'half'); assert.equal(x.done.commission, 0);
    const after = await api('GET', '/api/driver/dues', null, D.token);
    assert.equal(after.passes, 15); assert.equal(after.charged, before.charged + 15, 'pass price added to dues, no per-ride fee');
    const st = await api('GET', '/api/admin/stats', null, A.token); assert.equal(st.passesToday, 1); assert.equal(st.passRevenueToday, 15);
  });
  await step('admin: edit rate card (included km, platform fee) and pricing settings', async () => {
    const f = await api('GET', '/api/admin/fares', null, A.token);
    const bike = f.fares.find(x => x.vehicle === 'bike'); assert.equal(bike.base, 20); assert.equal(bike.included_km, 2); assert.equal(bike.platform_fee, 2);
    bike.platform_fee = 1;
    assert.equal((await api('PUT', '/api/admin/fares', { fares: [bike] }, A.token)).fares.find(x => x.vehicle === 'bike').platform_fee, 1);
    const pr = await api('GET', '/api/admin/pricing', null, A.token); assert.equal(pr.night.multiplier, 1.25); assert.equal(pr.pickup.freeKm, 2.5);
    pr.tiers.full.price = 25;
    assert.equal((await api('PUT', '/api/admin/pricing', pr, A.token)).tiers.full.price, 25);
    assert.equal((await api('PUT', '/api/admin/pricing', { ...pr, night: { ...pr.night, startHour: 25 } }, A.token)).status, 400);
    assert.equal((await api('PUT', '/api/admin/pricing', pr, P.token)).status, 403);
  });
  await step('passenger cancels a requested ride; offer closed for rider', async () => {
    const r = await api('POST', '/api/rides', { pickup: BLR, drop: KORA, vehicle: 'cab' }, P.token);
    await waitFor(D.token, 'ride:offer', o => o.rideId === r.ride.id);
    assert.equal((await api('POST', `/api/rides/${r.ride.id}/cancel`, { reason: 'changed plans' }, P.token)).ride.status, 'cancelled');
    await waitFor(D.token, 'ride:offer_closed', o => o.rideId === r.ride.id);
  });
  await step('unanswered ride expires to no_driver', async () => {
    await api('POST', '/api/driver/online', { online: false }, D.token); await api('POST', '/api/driver/online', { online: false }, D2.token);
    const r = await api('POST', '/api/rides', { pickup: BLR, drop: KORA, vehicle: 'bike' }, P.token);
    await S.db.exec('UPDATE rides SET requested_at = requested_at - 61000 WHERE id = $1', [r.ride.id]);
    await S.tick(true);
    assert.equal((await waitFor(P.token, 'ride:update', x => x.id === r.ride.id && x.status === 'no_driver')).status, 'no_driver');
  });
  await step('admin stats, fares edit, users, block', async () => {
    const s = await api('GET', '/api/admin/stats', null, A.token);
    const done = (await api('GET', '/api/rides/history', null, D.token)).rides.filter(r => r.status === 'completed');
    assert.equal(s.completedToday, done.length); assert.equal(s.revenueToday, done.reduce((t, r) => t + r.fare, 0)); assert.equal(s.passengers, 2); assert.equal(s.riders, 2);
    const f = await api('GET', '/api/admin/fares', null, A.token); f.fares[0].base = 20;
    assert.equal((await api('PUT', '/api/admin/fares', { fares: f.fares }, A.token)).fares[0].base, 20);
    assert.equal((await api('GET', '/api/admin/users?role=driver', null, A.token)).users.length, 2);
    await api('POST', `/api/admin/users/${D2.user.id}/block`, {}, A.token);
    assert.equal((await api('GET', '/api/me', null, D2.token)).status, 401, 'blocked user session revoked');
    assert.equal((await api('POST', '/api/auth/otp/send', { phone: '9876500003', role: 'driver' })).status, 403);
  });
  await step('regions: public list; pickup/drop must be inside an active region', async () => {
    const list = (await api('GET', '/api/regions')).regions;
    const blr = list.find(r => r.name === 'Bengaluru'); assert.ok(blr && blr.active && list.length >= 15);
    const nowhere = { lat: 15.2, lng: 75.1 }; // rural Karnataka, outside every seeded city
    const q1 = await api('POST', '/api/rides/quote', { pickup: nowhere, drop: { lat: 15.25, lng: 75.15 } }, P.token);
    assert.equal(q1.status, 403); assert.equal(q1.code, 'not_serviceable');
    const q2 = await api('POST', '/api/rides/quote', { pickup: BLR, drop: { lat: 13.35, lng: 77.1 } }, P.token); // ~55 km away (Tumakuru)
    assert.equal(q2.status, 403); assert.equal(q2.code, 'drop_outside');
    const q3 = await api('POST', '/api/rides/quote', { pickup: BLR, drop: KORA }, P.token);
    assert.equal(q3.status, 200); assert.equal(q3.region.name, 'Bengaluru');
  });
  await step('regions: admin makes a city not reachable / reachable, adds and removes regions', async () => {
    const regs = (await api('GET', '/api/admin/regions', null, A.token)).regions;
    const blr = regs.find(r => r.name === 'Bengaluru'); assert.ok(blr.rides30d >= 1, 'ride count per region');
    assert.equal((await api('PUT', `/api/admin/regions/${blr.id}`, { active: false }, A.token)).region.active, false);
    const q = await api('POST', '/api/rides/quote', { pickup: BLR, drop: KORA }, P.token);
    assert.equal(q.status, 403); assert.match(q.error, /coming soon to Bengaluru/);
    assert.equal((await api('POST', '/api/rides', { pickup: BLR, drop: KORA, vehicle: 'cab' }, P.token)).status, 403, 'booking blocked too');
    assert.equal((await api('PUT', `/api/admin/regions/${blr.id}`, { active: true, radiusKm: 40 }, A.token)).region.radiusKm, 40);
    assert.equal((await api('POST', '/api/rides/quote', { pickup: BLR, drop: KORA }, P.token)).status, 200);
    const add = await api('POST', '/api/admin/regions', { name: 'Mysuru', state: 'Karnataka', lat: 12.2958, lng: 76.6394, radiusKm: 15, active: false }, A.token);
    assert.equal(add.status, 200, add.error); assert.equal(add.region.active, false);
    assert.equal((await api('POST', '/api/admin/regions', { name: 'mysuru', lat: 12.3, lng: 76.6, radiusKm: 10 }, A.token)).status, 409, 'duplicate name');
    assert.equal((await api('POST', '/api/admin/regions', { name: 'London', lat: 51.5, lng: -0.12, radiusKm: 10 }, A.token)).status, 400, 'India only');
    const q4 = await api('POST', '/api/rides/quote', { pickup: { lat: 12.30, lng: 76.64 }, drop: { lat: 12.31, lng: 76.66 } }, P.token);
    assert.match(q4.error, /coming soon to Mysuru/);
    assert.equal((await api('DELETE', `/api/admin/regions/${add.region.id}`, null, A.token)).status, 200);
    assert.equal((await api('PUT', `/api/admin/regions/${blr.id}`, { active: false }, P.token)).status, 403, 'only admin');
  });
  await step('stay logged in: sessions slide forward on use (no re-login until logout)', async () => {
    const h = require('node:crypto').createHash('sha256').update(P.token).digest('hex');
    await S.db.exec('UPDATE sessions SET expires_at = $1 WHERE token_hash = $2', [Date.now() + 60_000, h]); // about to expire
    assert.equal((await api('GET', '/api/me', null, P.token)).status, 200);
    const s = await S.db.one('SELECT expires_at FROM sessions WHERE token_hash = $1', [h]);
    assert.ok(s.expires_at > Date.now() + 300 * 24 * 3600_000, 'extended to ~1 year');
    const t2 = await login('9876500077', 'passenger');
    assert.equal((await api('POST', '/api/logout', {}, t2.token)).status, 200);
    assert.equal((await api('GET', '/api/me', null, t2.token)).status, 401, 'logout ends the session');
  });
  await step('admin sees test-mode OTP codes', async () => { const o = await api('GET', '/api/admin/otps', null, A.token); assert.equal(o.testMode, true); assert.ok(o.codes.length >= 4); });
  await step('admin password change', async () => {
    assert.equal((await api('POST', '/api/admin/password', { current: 'test-admin-pass', next: 'new-pass-123' }, A.token)).status, 200);
    assert.ok((await api('POST', '/api/admin/login', { username: 'Administrator', password: 'new-pass-123' })).token);
  });
  await step('admin email: set from ADMIN_EMAIL, login by email (any case), change in settings', async () => {
    assert.equal((await api('GET', '/api/admin/me', null, A.token)).admin.email, 'owner.test@example.com');
    assert.ok((await api('POST', '/api/admin/login', { username: 'OWNER.test@example.com', password: 'new-pass-123' })).token);
    assert.equal((await api('POST', '/api/admin/login', { username: 'owner.test@example.com', password: 'wrong' })).status, 401);
    assert.equal((await api('PUT', '/api/admin/email', { email: 'not-an-email' }, A.token)).status, 400);
    assert.equal((await api('PUT', '/api/admin/email', { email: 'new.admin@gmail.com' }, A.token)).email, 'new.admin@gmail.com');
    assert.ok((await api('POST', '/api/admin/login', { username: 'new.admin@gmail.com', password: 'new-pass-123' })).token);
    assert.equal((await api('POST', '/api/admin/login', { username: 'owner.test@example.com', password: 'new-pass-123' })).status, 401, 'old email no longer works');
    assert.equal((await api('PUT', '/api/admin/email', { email: 'x@y.com' }, P.token)).status, 403, 'passengers cannot change it');
  });
  await step('geo search fails gracefully when map services are unreachable', async () => {
    const r = await api('GET', '/api/geo/search?q=Koramangala', null, P.token);
    assert.equal(r.status, 503); assert.match(r.error, /map/);
  });
  await step('a second app instance (like another serverless instance) shares state', async () => {
    const S2 = createApp(cfg); const s2 = http.createServer(S2.app); await new Promise(r => s2.listen(0, r));
    const r = await fetch('http://127.0.0.1:' + s2.address().port + '/api/me', { headers: { Authorization: 'Bearer ' + P.token } }).then(x => x.json());
    assert.equal(r.user.name, 'Asha Rao');
    s2.close(); await S2.close();
  });

  server.close(); await S.close();
  for (const [st, n] of results) console.log(st, n);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
