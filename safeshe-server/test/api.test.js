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

  const cfg = loadConfig({ DATABASE_URL: DB, ADMIN_PASSWORD: 'test-admin-pass', OTP_SHOW_IN_APP: '1', QUIET: '1',
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
    assert.equal(s.completedToday, 1); assert.equal(s.revenueToday, ride.fare); assert.equal(s.passengers, 2); assert.equal(s.riders, 2);
    const f = await api('GET', '/api/admin/fares', null, A.token); f.fares[0].base = 20;
    assert.equal((await api('PUT', '/api/admin/fares', { fares: f.fares }, A.token)).fares[0].base, 20);
    assert.equal((await api('GET', '/api/admin/users?role=driver', null, A.token)).users.length, 2);
    await api('POST', `/api/admin/users/${D2.user.id}/block`, {}, A.token);
    assert.equal((await api('GET', '/api/me', null, D2.token)).status, 401, 'blocked user session revoked');
    assert.equal((await api('POST', '/api/auth/otp/send', { phone: '9876500003', role: 'driver' })).status, 403);
  });
  await step('admin sees test-mode OTP codes', async () => { const o = await api('GET', '/api/admin/otps', null, A.token); assert.equal(o.testMode, true); assert.ok(o.codes.length >= 4); });
  await step('admin password change', async () => {
    assert.equal((await api('POST', '/api/admin/password', { current: 'test-admin-pass', next: 'new-pass-123' }, A.token)).status, 200);
    assert.ok((await api('POST', '/api/admin/login', { username: 'Administrator', password: 'new-pass-123' })).token);
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
