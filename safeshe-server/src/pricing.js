'use strict';
/*
 * SafeShe pricing engine.
 *
 *   Upfront fare = Base fare
 *                + max(0, distance − included km) × per-km rate
 *                + traffic minutes × per-minute rate      (0 upfront; added only for gridlock, see below)
 *                + platform fee
 *
 *   Night premium:  base + distance + traffic charge × multiplier (default 1.25×, 23:00–05:00 India time).
 *                   The platform fee and the pickup surcharge are not multiplied.
 *   Long pickup:    + ₹1.50 for every pickup km beyond 2.5 km, added when a rider accepts. 100% goes to the rider.
 *   Gridlock:       per-minute charge applies only while the vehicle stays below 8 km/h for more than 3 consecutive
 *                   minutes (measured from the rider's GPS during the trip). Gaps in GPS (>2 min) are never billed.
 * All amounts are configurable by the admin (fares table + pricing settings).
 */

const DEFAULT_PRICING = {
  night: { enabled: true, multiplier: 1.25, startHour: 23, endHour: 5, timeZone: 'Asia/Kolkata' },
  pickup: { freeKm: 2.5, perKm: 1.5 },
  gridlock: { speedKmh: 8, minMinutes: 3, maxGapSec: 120 },
  tiers: {
    perRide: { name: 'Casual (pay per ride)', fee: 3 },
    half: { name: 'Half-Day Pass', price: 15, hours: 6 },
    full: { name: 'Full-Day Pass', price: 29, hours: 24 },
  },
};

const round2 = n => Math.round(n * 100) / 100;
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

/** Merge stored settings over the defaults (unknown keys ignored). */
function normalizePricing(p) {
  const d = DEFAULT_PRICING, s = p || {};
  const n = s.night || {}, pk = s.pickup || {}, g = s.gridlock || {}, t = s.tiers || {};
  return {
    night: { enabled: n.enabled !== undefined ? !!n.enabled : d.night.enabled, multiplier: num(n.multiplier, d.night.multiplier),
      startHour: num(n.startHour, d.night.startHour), endHour: num(n.endHour, d.night.endHour), timeZone: n.timeZone || d.night.timeZone },
    pickup: { freeKm: num(pk.freeKm, d.pickup.freeKm), perKm: num(pk.perKm, d.pickup.perKm) },
    gridlock: { speedKmh: num(g.speedKmh, d.gridlock.speedKmh), minMinutes: num(g.minMinutes, d.gridlock.minMinutes), maxGapSec: num(g.maxGapSec, d.gridlock.maxGapSec) },
    tiers: {
      perRide: { name: (t.perRide && t.perRide.name) || d.tiers.perRide.name, fee: num(t.perRide && t.perRide.fee, d.tiers.perRide.fee) },
      half: { name: (t.half && t.half.name) || d.tiers.half.name, price: num(t.half && t.half.price, d.tiers.half.price), hours: num(t.half && t.half.hours, d.tiers.half.hours) },
      full: { name: (t.full && t.full.name) || d.tiers.full.name, price: num(t.full && t.full.price, d.tiers.full.price), hours: num(t.full && t.full.hours, d.tiers.full.hours) },
    },
  };
}

/** Validate admin input; returns the normalized settings or throws a message. */
function validatePricing(p) {
  const v = normalizePricing(p);
  const bad = m => { throw Object.assign(new Error(m), { status: 400 }); };
  if (!(v.night.multiplier >= 1 && v.night.multiplier <= 3)) bad('Night multiplier must be between 1 and 3.');
  for (const h of [v.night.startHour, v.night.endHour]) if (!(Number.isInteger(h) && h >= 0 && h <= 23)) bad('Night hours must be whole hours 0–23.');
  if (!(v.pickup.freeKm >= 0 && v.pickup.freeKm <= 20) || !(v.pickup.perKm >= 0 && v.pickup.perKm <= 100)) bad('Pickup surcharge values are out of range.');
  if (!(v.gridlock.speedKmh > 0 && v.gridlock.speedKmh <= 30) || !(v.gridlock.minMinutes >= 0 && v.gridlock.minMinutes <= 30)) bad('Gridlock values are out of range.');
  if (!(v.tiers.perRide.fee >= 0 && v.tiers.perRide.fee <= 500)) bad('Per-ride fee is out of range.');
  for (const k of ['half', 'full']) {
    if (!(v.tiers[k].price >= 0 && v.tiers[k].price <= 5000)) bad(`${v.tiers[k].name} price is out of range.`);
    if (!(v.tiers[k].hours >= 1 && v.tiers[k].hours <= 720)) bad(`${v.tiers[k].name} hours must be 1–720.`);
  }
  return v;
}

/** Hour of day (0–23) in the configured time zone. */
function localHour(ts, timeZone) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ts));
  return parseInt(h, 10) % 24;
}
function isNight(ts, pricing) {
  const n = pricing.night;
  if (!n.enabled || n.multiplier <= 1) return false;
  const h = localHour(ts, n.timeZone);
  return n.startHour > n.endHour ? (h >= n.startHour || h < n.endHour) : (h >= n.startHour && h < n.endHour);
}

/**
 * Fare for a ride. `rate` is a fares-table row; km = trip distance; trafficMin = billable gridlock minutes.
 * Returns a breakdown; `total` is rounded to the nearest rupee.
 */
function computeFare(rate, { km, trafficMin = 0, pickupSurcharge = 0, night = false }, pricing) {
  const mult = night ? pricing.night.multiplier : 1;
  const includedKm = Math.max(0, rate.included_km || 0);
  const chargeableKm = Math.max(0, km - includedKm);
  const base = rate.base;
  const distance = chargeableKm * rate.per_km;
  const traffic = trafficMin * rate.per_min;
  const nightExtra = (base + distance + traffic) * (mult - 1);
  const platformFee = rate.platform_fee || 0;
  let total = base + distance + traffic + nightExtra + platformFee + pickupSurcharge;
  if (rate.min_fare && total < rate.min_fare) total = rate.min_fare;
  return {
    base: round2(base), includedKm, chargeableKm: round2(chargeableKm), perKm: rate.per_km, distance: round2(distance),
    trafficMin: round2(trafficMin), perMin: rate.per_min, traffic: round2(traffic),
    night, nightMultiplier: mult, nightExtra: round2(nightExtra),
    platformFee: round2(platformFee), pickupSurcharge: round2(pickupSurcharge),
    total: Math.round(total),
  };
}

/** Long-pickup surcharge for a rider `pickupKm` away from the passenger. */
function pickupSurcharge(pickupKm, pricing) {
  const extra = Math.max(0, pickupKm - pricing.pickup.freeKm);
  return round2(extra * pricing.pickup.perKm);
}

/**
 * Gridlock tracker. Feed it the rider's GPS points during a trip; it returns the updated state.
 * State: { lat, lng, at, slowSince, counted, sec } — `sec` is the billable gridlock time in seconds.
 * A slow stretch (speed < speedKmh) becomes billable once it lasts longer than minMinutes; then the whole
 * stretch is billed. GPS gaps longer than maxGapSec end the stretch and are not billed.
 */
function trackGridlock(state, point, at, pricing, distanceKm) {
  const g = pricing.gridlock;
  const s = Object.assign({ lat: null, lng: null, at: null, slowSince: null, counted: false, sec: 0 }, state || {});
  if (s.at == null || s.lat == null) return { ...s, lat: point.lat, lng: point.lng, at };
  const dtMs = at - s.at;
  if (dtMs <= 0) return s;
  const next = { ...s, lat: point.lat, lng: point.lng, at };
  if (dtMs > g.maxGapSec * 1000) return { ...next, slowSince: null, counted: false };
  const kmh = distanceKm(s, point) / (dtMs / 3600000);
  if (kmh >= g.speedKmh) return { ...next, slowSince: null, counted: false };
  const slowSince = s.slowSince == null ? s.at : s.slowSince;
  const slowMs = at - slowSince;
  let sec = s.sec, counted = s.counted;
  if (slowMs > g.minMinutes * 60000) {
    if (!counted) { sec += slowMs / 1000; counted = true; } // stretch just qualified: bill all of it
    else sec += dtMs / 1000;                                 // already billing: add this interval
  }
  return { ...next, slowSince, counted, sec: round2(sec) };
}

module.exports = { DEFAULT_PRICING, normalizePricing, validatePricing, computeFare, pickupSurcharge, trackGridlock, isNight, localHour };
