'use strict';
/*
 * Admin reports: collect statistics for a date range (India time) and render them as a PDF.
 *   buildReport(db, { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }) → data
 *   renderPdf(data) → Promise<Buffer>
 */
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { haversineKm } = require('./geo');

const TZ = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';
const DAY = 24 * 3600_000;
// Read with literal paths so Vercel's file tracer bundles the fonts with the function.
let fonts = null;
function loadFonts() {
  if (!fonts) fonts = {
    regular: fs.readFileSync(path.join(__dirname, '..', 'fonts', 'DejaVuSans.ttf')),
    bold: fs.readFileSync(path.join(__dirname, '..', 'fonts', 'DejaVuSans-Bold.ttf')),
  };
  return fonts;
}
const VEH = { bike: 'Bike', auto: 'Auto', cab: 'Cab', pink: 'Pink Cab' };

const round2 = n => Math.round((n || 0) * 100) / 100;
const err = (status, m) => Object.assign(new Error(m), { status });

/** Today's date in India as YYYY-MM-DD. */
function todayIst(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
function addDays(ymd, n) {
  const d = new Date(Date.parse(ymd + 'T12:00:00Z') + n * DAY);
  return d.toISOString().slice(0, 10);
}
function istDate(ts) { return todayIst(ts); }

/** Resolve ?days=7|90 or ?from=&to= into an India-time date range. */
function resolveRange(q, now = Date.now()) {
  let from = q.from, to = q.to;
  if (q.days) {
    const days = Math.round(+q.days);
    if (!(days >= 1 && days <= 366)) throw err(400, 'Days must be between 1 and 366.');
    to = todayIst(now); from = addDays(to, -(days - 1));
  }
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '')) throw err(400, 'Choose a start and end date.');
  const start = Date.parse(from + 'T00:00:00' + IST_OFFSET), end = Date.parse(to + 'T23:59:59.999' + IST_OFFSET);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw err(400, 'Invalid date.');
  if (start > end) throw err(400, 'The start date must be on or before the end date.');
  if (end - start > 366 * DAY) throw err(400, 'A report can cover at most 366 days.');
  if (start > now) throw err(400, 'The start date is in the future.');
  return { from, to, start, end, days: Math.round((end + 1 - start) / DAY) };
}

async function buildReport(db, range) {
  const { start, end } = range;
  const [rides, passes, paymentsConfirmed, paymentsPending, users, sos, regions, ridersApproved] = await Promise.all([
    db.q(`SELECT r.id, r.status, r.vehicle, r.fare, r.platform_fee, r.commission, r.distance_km, r.night, r.pickup_surcharge, r.gridlock,
            r.pickup_lat, r.pickup_lng, r.requested_at, r.completed_at, r.cancelled_by, r.driver_id, r.payment,
            u.name AS d_name, u.phone AS d_phone, d.plate AS d_plate
          FROM rides r LEFT JOIN users u ON u.id = r.driver_id LEFT JOIN drivers d ON d.user_id = r.driver_id
          WHERE r.requested_at BETWEEN $1 AND $2 ORDER BY r.requested_at`, [start, end]),
    db.q('SELECT kind, price, created_at FROM driver_passes WHERE created_at BETWEEN $1 AND $2', [start, end]),
    db.one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM commission_payments WHERE status = 'confirmed' AND reviewed_at BETWEEN $1 AND $2", [start, end]),
    db.one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM commission_payments WHERE status = 'pending'", []),
    db.q('SELECT role, created_at FROM users WHERE created_at BETWEEN $1 AND $2', [start, end]),
    db.q(`SELECT s.id, s.created_at, s.resolved_at, s.ride_id, s.lat, s.lng, u.name, u.phone, u.role
          FROM sos s JOIN users u ON u.id = s.user_id WHERE s.created_at BETWEEN $1 AND $2 ORDER BY s.created_at`, [start, end]),
    db.q('SELECT name, lat, lng, radius_km, active FROM regions ORDER BY sort, name'),
    db.one("SELECT COUNT(*) AS n FROM drivers WHERE status = 'approved'"),
  ]);

  const done = rides.filter(r => r.status === 'completed');
  const sum = (arr, f) => round2(arr.reduce((t, x) => t + (f(x) || 0), 0));
  const gross = sum(done, r => r.fare);
  const platformFees = sum(done, r => r.platform_fee);
  const rideFees = sum(done, r => r.commission);
  const passRevenue = sum(passes, p => p.price);
  const summary = {
    requested: rides.length,
    completed: done.length,
    cancelledByPassenger: rides.filter(r => r.status === 'cancelled' && r.cancelled_by === 'passenger').length,
    cancelledByRider: rides.filter(r => r.status === 'cancelled' && r.cancelled_by === 'driver').length,
    cancelledByAdmin: rides.filter(r => r.status === 'cancelled' && r.cancelled_by === 'admin').length,
    noRider: rides.filter(r => r.status === 'no_driver').length,
    active: rides.filter(r => ['requested', 'accepted', 'arrived', 'started'].includes(r.status)).length,
    completionRate: rides.length ? Math.round(done.length / rides.length * 1000) / 10 : 0,
    gross, avgFare: done.length ? round2(gross / done.length) : 0,
    totalKm: sum(done, r => r.distance_km), avgKm: done.length ? round2(sum(done, r => r.distance_km) / done.length) : 0,
    nightRides: done.filter(r => r.night).length,
    pickupSurcharges: sum(done, r => r.pickup_surcharge),
    trafficMinutes: round2(done.reduce((t, r) => t + ((r.gridlock && r.gridlock.sec) || 0), 0) / 60),
    cashRides: done.filter(r => r.payment !== 'upi').length, upiRides: done.filter(r => r.payment === 'upi').length,
    platformFees, rideFees, passesSold: passes.length, halfPasses: passes.filter(p => p.kind === 'half').length,
    fullPasses: passes.filter(p => p.kind === 'full').length, passRevenue,
    safeSheEarnings: round2(platformFees + rideFees + passRevenue),
    riderEarnings: round2(gross - platformFees),
    paymentsReceived: round2(paymentsConfirmed.amount), paymentsReceivedCount: paymentsConfirmed.n,
    paymentsPending: round2(paymentsPending.amount), paymentsPendingCount: paymentsPending.n,
    newPassengers: users.filter(u => u.role === 'passenger').length, newRiders: users.filter(u => u.role === 'driver').length,
    ridersApproved: ridersApproved.n,
    sosTotal: sos.length, sosOpen: sos.filter(s => !s.resolved_at).length,
  };

  const byVehicle = Object.keys(VEH).map(v => {
    const all = rides.filter(r => r.vehicle === v), c = all.filter(r => r.status === 'completed');
    return { vehicle: VEH[v], requested: all.length, completed: c.length, revenue: sum(c, r => r.fare), avgFare: c.length ? round2(sum(c, r => r.fare) / c.length) : 0, fees: sum(c, r => r.platform_fee + r.commission) };
  }).filter(x => x.requested);

  const regionOf = r => {
    let best = null, bestKm = Infinity;
    for (const g of regions) { const km = haversineKm(g, { lat: r.pickup_lat, lng: r.pickup_lng }); if (km <= g.radius_km && km < bestKm) { best = g; bestKm = km; } }
    return best ? best.name : 'Outside regions';
  };
  const regMap = {};
  for (const r of rides) {
    const k = regionOf(r); const e = regMap[k] || (regMap[k] = { region: k, requested: 0, completed: 0, revenue: 0 });
    e.requested++; if (r.status === 'completed') { e.completed++; e.revenue = round2(e.revenue + r.fare); }
  }
  const byRegion = Object.values(regMap).sort((a, b) => b.completed - a.completed || b.requested - a.requested);

  const dayMap = {};
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) dayMap[d] = { date: d, requested: 0, completed: 0, revenue: 0, earnings: 0 };
  for (const r of rides) {
    const e = dayMap[istDate(r.requested_at)]; if (!e) continue;
    e.requested++; if (r.status === 'completed') { e.completed++; e.revenue = round2(e.revenue + r.fare); e.earnings = round2(e.earnings + r.platform_fee + r.commission); }
  }
  for (const p of passes) { const e = dayMap[istDate(p.created_at)]; if (e) e.earnings = round2(e.earnings + p.price); }
  const daily = Object.values(dayMap);

  const riderMap = {};
  for (const r of done) {
    if (!r.driver_id) continue;
    const e = riderMap[r.driver_id] || (riderMap[r.driver_id] = { name: r.d_name || 'Rider', phone: r.d_phone || '', plate: r.d_plate || '', rides: 0, earned: 0 });
    e.rides++; e.earned = round2(e.earned + r.fare - (r.platform_fee || 0));
  }
  const topRiders = Object.values(riderMap).sort((a, b) => b.rides - a.rides || b.earned - a.earned).slice(0, 15);

  const sosList = sos.map(s => ({ at: s.created_at, name: s.name || '', phone: s.phone, role: s.role === 'driver' ? 'Rider' : 'Passenger', rideId: s.ride_id, resolved: !!s.resolved_at }));

  return { range: { from: range.from, to: range.to, days: range.days }, generatedAt: Date.now(), summary, byVehicle, byRegion, daily, topRiders, sos: sosList };
}

// ------------------------------------------------------------------ PDF
const GREEN = '#0f9d58', DARK = '#17201b', MUTED = '#66736b', LINE = '#dfe7e2', SOFT = '#e6f5ec';
const rs = n => '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const fmtDate = ymd => new Date(Date.parse(ymd + 'T12:00:00Z')).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtTs = ts => new Date(ts).toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function renderPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 48, left: 40, right: 40 }, bufferPages: true,
      info: { Title: `SafeShe report ${data.range.from} to ${data.range.to}`, Author: 'SafeShe Rides', Subject: 'Admin report' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const f = loadFonts(); doc.registerFont('R', f.regular); doc.registerFont('B', f.bold); doc.font('R');
    const W = doc.page.width - 80, X = 40;
    const s = data.summary;

    // header band
    doc.rect(0, 0, doc.page.width, 92).fill(GREEN);
    doc.fill('#fff').font('B').fontSize(22).text('SafeShe Rides', X, 24);
    doc.font('R').fontSize(11).text('Admin report', X, 52);
    doc.fontSize(11).text(`${fmtDate(data.range.from)} – ${fmtDate(data.range.to)} (${data.range.days} day${data.range.days > 1 ? 's' : ''})`, X, 30, { width: W, align: 'right' });
    doc.fontSize(9).text(`Generated ${fmtTs(data.generatedAt)} IST`, X, 52, { width: W, align: 'right' });
    doc.fill(DARK); doc.y = 110;

    const ensure = h => { if (doc.y + h > doc.page.height - 60) { doc.addPage(); doc.y = 48; } };
    const heading = t => { ensure(90); doc.moveDown(0.6); doc.font('B').fontSize(13).fill(GREEN).text(t, X, doc.y); doc.moveDown(0.3); doc.fill(DARK).font('R'); };

    // KPI cards
    function cards(items) {
      const cols = 3, gap = 10, cw = (W - gap * (cols - 1)) / cols, ch = 46;
      for (let i = 0; i < items.length; i += cols) {
        ensure(ch + gap); const y = doc.y;
        items.slice(i, i + cols).forEach((it, j) => {
          const x = X + j * (cw + gap);
          doc.roundedRect(x, y, cw, ch, 6).fillAndStroke(it.alert ? '#fdecea' : SOFT, it.alert ? '#f5b5b0' : '#bfe3cc');
          doc.fill(MUTED).font('R').fontSize(8).text(it.label, x + 8, y + 7, { width: cw - 16, lineBreak: false, ellipsis: true });
          doc.fill(DARK).font('B').fontSize(14).text(String(it.value), x + 8, y + 21, { width: cw - 16 });
        });
        doc.y = y + ch + gap;
      }
      doc.font('R');
    }
    // simple table with page breaks
    function table(cols, rows, opts = {}) {
      const rowH = 18, fs = 8.5;
      const header = () => {
        ensure(rowH * 2); const y = doc.y;
        doc.rect(X, y, W, rowH).fill(DARK);
        let x = X; doc.fill('#fff').font('B').fontSize(fs);
        cols.forEach(c => { doc.text(c.label, x + 5, y + 5, { width: c.w * W - 10, align: c.align || 'left', lineBreak: false, ellipsis: true }); x += c.w * W; });
        doc.y = y + rowH; doc.font('R');
      };
      header();
      if (!rows.length) { doc.fill(MUTED).fontSize(fs).text(opts.empty || 'No data for this period.', X + 5, doc.y + 5); doc.y += rowH; doc.fill(DARK); return; }
      rows.forEach((r, i) => {
        if (doc.y + rowH > doc.page.height - 60) { doc.addPage(); doc.y = 48; header(); }
        const y = doc.y;
        if (i % 2) doc.rect(X, y, W, rowH).fill('#f6f9f7');
        if (opts.total && i === rows.length - 1) doc.rect(X, y, W, rowH).fill(SOFT);
        let x = X; doc.fill(DARK).font(opts.total && i === rows.length - 1 ? 'B' : 'R').fontSize(fs);
        cols.forEach((c, j) => { doc.text(String(r[j] == null ? '' : r[j]), x + 5, y + 5, { width: c.w * W - 10, align: c.align || 'left', lineBreak: false, ellipsis: true }); x += c.w * W; });
        doc.moveTo(X, y + rowH).lineTo(X + W, y + rowH).strokeColor(LINE).lineWidth(0.5).stroke();
        doc.y = y + rowH;
      });
      doc.font('R');
    }

    heading('Rides');
    cards([
      { label: 'Ride requests', value: s.requested }, { label: 'Completed', value: s.completed }, { label: 'Completion rate', value: s.completionRate + '%' },
      { label: 'Cancelled (passenger/rider/admin)', value: `${s.cancelledByPassenger} / ${s.cancelledByRider} / ${s.cancelledByAdmin}` },
      { label: 'No rider found', value: s.noRider, alert: s.noRider > 0 }, { label: 'Still active', value: s.active },
      { label: 'Total fares (completed)', value: rs(s.gross) }, { label: 'Average fare', value: rs(s.avgFare) }, { label: 'Distance (total / average)', value: `${s.totalKm} / ${s.avgKm} km` },
      { label: 'Cash / UPI rides', value: `${s.cashRides} / ${s.upiRides}` }, { label: 'Night rides (premium)', value: s.nightRides }, { label: 'Traffic minutes billed', value: s.trafficMinutes },
    ]);
    heading('SafeShe earnings');
    cards([
      { label: 'Total SafeShe earnings', value: rs(s.safeSheEarnings) }, { label: 'Platform fees', value: rs(s.platformFees) }, { label: 'Per-ride fees (Tier 1)', value: rs(s.rideFees) },
      { label: 'Passes sold (half / full)', value: `${s.passesSold} (${s.halfPasses} / ${s.fullPasses})` }, { label: 'Pass revenue', value: rs(s.passRevenue) }, { label: 'Riders kept (fares − platform fees)', value: rs(s.riderEarnings) },
      { label: 'UPI payments confirmed', value: `${rs(s.paymentsReceived)} (${s.paymentsReceivedCount})` }, { label: 'Payments waiting to verify (now)', value: `${rs(s.paymentsPending)} (${s.paymentsPendingCount})`, alert: s.paymentsPendingCount > 0 }, { label: 'Long-pickup surcharges (to riders)', value: rs(s.pickupSurcharges) },
    ]);
    heading('People & safety');
    cards([
      { label: 'New passengers', value: s.newPassengers }, { label: 'New riders', value: s.newRiders }, { label: 'Approved riders (total now)', value: s.ridersApproved },
      { label: 'SOS alerts', value: s.sosTotal, alert: s.sosTotal > 0 }, { label: 'SOS still open', value: s.sosOpen, alert: s.sosOpen > 0 }, { label: 'Report period', value: `${data.range.days} days` },
    ]);

    heading('By vehicle type');
    const vt = data.byVehicle.map(v => [v.vehicle, v.requested, v.completed, rs(v.revenue), rs(v.avgFare), rs(v.fees)]);
    if (vt.length) vt.push(['Total', s.requested, s.completed, rs(s.gross), rs(s.avgFare), rs(round2(s.platformFees + s.rideFees))]);
    table([{ label: 'Vehicle', w: 0.22 }, { label: 'Requests', w: 0.13, align: 'right' }, { label: 'Completed', w: 0.14, align: 'right' }, { label: 'Fares', w: 0.18, align: 'right' }, { label: 'Avg fare', w: 0.15, align: 'right' }, { label: 'SafeShe fees', w: 0.18, align: 'right' }], vt, { total: vt.length > 0 });

    heading('By region');
    table([{ label: 'Region', w: 0.4 }, { label: 'Requests', w: 0.18, align: 'right' }, { label: 'Completed', w: 0.18, align: 'right' }, { label: 'Fares', w: 0.24, align: 'right' }],
      data.byRegion.map(r => [r.region, r.requested, r.completed, rs(r.revenue)]));

    heading('Day by day (India time)');
    const dt = data.daily.map(d => [fmtDate(d.date), d.requested, d.completed, rs(d.revenue), rs(d.earnings)]);
    dt.push(['Total', s.requested, s.completed, rs(s.gross), rs(s.safeSheEarnings)]);
    table([{ label: 'Date', w: 0.28 }, { label: 'Requests', w: 0.16, align: 'right' }, { label: 'Completed', w: 0.16, align: 'right' }, { label: 'Fares', w: 0.2, align: 'right' }, { label: 'SafeShe earnings', w: 0.2, align: 'right' }], dt, { total: true });

    heading('Top riders');
    table([{ label: '#', w: 0.06 }, { label: 'Rider', w: 0.3 }, { label: 'Phone', w: 0.2 }, { label: 'Vehicle no.', w: 0.18 }, { label: 'Rides', w: 0.1, align: 'right' }, { label: 'Earned', w: 0.16, align: 'right' }],
      data.topRiders.map((r, i) => [i + 1, r.name, r.phone, r.plate, r.rides, rs(r.earned)]), { empty: 'No completed rides in this period.' });

    heading('SOS alerts');
    table([{ label: 'Time (IST)', w: 0.26 }, { label: 'Name', w: 0.24 }, { label: 'Phone', w: 0.2 }, { label: 'Role', w: 0.12 }, { label: 'Ride', w: 0.08 }, { label: 'Status', w: 0.1 }],
      data.sos.map(a => [fmtTs(a.at), a.name, a.phone, a.role, a.rideId ? '#' + a.rideId : '–', a.resolved ? 'Resolved' : 'OPEN']), { empty: 'No SOS alerts in this period.' });

    ensure(40); doc.moveDown(1);
    doc.fill(MUTED).fontSize(7.5).text('Rides are counted by the time they were requested (India time). SafeShe earnings = platform fees + per-ride fees + passes sold. ' +
      'Riders keep each fare minus the platform fee; long-pickup surcharges go 100% to riders. Payments are UPI payments confirmed by the admin in this period.', X, doc.y, { width: W });

    // footer on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // writing in the footer area must not start a new page
      doc.fill(MUTED).font('R').fontSize(8).text(`SafeShe Rides · Confidential · Page ${i + 1} of ${range.count}`, X, doc.page.height - 34, { width: W, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { buildReport, renderPdf, resolveRange, todayIst };
