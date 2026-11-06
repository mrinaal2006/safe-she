'use strict';
// PostgreSQL storage. Works with Neon (Vercel Storage), Supabase, Render Postgres or any Postgres 13+.
// Connection string from DATABASE_URL (or POSTGRES_URL, which Vercel's Neon integration sets).
const pg = require('pg');

// Return BIGINT/COUNT as JS numbers (timestamps in ms and ids fit safely in a double).
pg.types.setTypeParser(20, v => Number(v));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('passenger','driver')),
    name TEXT NOT NULL DEFAULT '',
    gender TEXT NOT NULL DEFAULT '',
    emergency_phone TEXT NOT NULL DEFAULT '',
    blocked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    UNIQUE (phone, role)
  );
  CREATE TABLE IF NOT EXISTS drivers (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('bike','auto','cab')),
    vehicle_model TEXT NOT NULL,
    plate TEXT NOT NULL,
    license_no TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    online BOOLEAN NOT NULL DEFAULT FALSE,
    lat DOUBLE PRECISION, lng DOUBLE PRECISION, loc_at BIGINT,
    rating_sum INTEGER NOT NULL DEFAULT 0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admins (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  ALTER TABLE admins ADD COLUMN IF NOT EXISTS email TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS admins_email ON admins (LOWER(email));
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('user','admin')),
    subject_id BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS otps (
    phone TEXT NOT NULL, role TEXT NOT NULL,
    code_hash TEXT NOT NULL, expires_at BIGINT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (phone, role)
  );
  CREATE TABLE IF NOT EXISTS otp_sends (phone TEXT NOT NULL, ip TEXT NOT NULL, at BIGINT NOT NULL);
  CREATE INDEX IF NOT EXISTS otp_sends_phone ON otp_sends(phone, at);
  CREATE TABLE IF NOT EXISTS otp_test_codes (id BIGSERIAL PRIMARY KEY, phone TEXT NOT NULL, code TEXT NOT NULL, at BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS fares (
    vehicle TEXT PRIMARY KEY,
    name TEXT NOT NULL, base DOUBLE PRECISION NOT NULL, per_km DOUBLE PRECISION NOT NULL, per_min DOUBLE PRECISION NOT NULL,
    min_fare DOUBLE PRECISION NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rides (
    id BIGSERIAL PRIMARY KEY,
    passenger_id BIGINT NOT NULL REFERENCES users(id),
    driver_id BIGINT REFERENCES users(id),
    vehicle TEXT NOT NULL,
    status TEXT NOT NULL,
    pickup_lat DOUBLE PRECISION NOT NULL, pickup_lng DOUBLE PRECISION NOT NULL, pickup_name TEXT NOT NULL,
    drop_lat DOUBLE PRECISION NOT NULL, drop_lng DOUBLE PRECISION NOT NULL, drop_name TEXT NOT NULL,
    distance_km DOUBLE PRECISION NOT NULL, duration_min DOUBLE PRECISION NOT NULL, route_approx BOOLEAN NOT NULL DEFAULT FALSE,
    fare DOUBLE PRECISION NOT NULL, payment TEXT NOT NULL DEFAULT 'cash',
    otp TEXT NOT NULL, share_token TEXT NOT NULL UNIQUE,
    requested_at BIGINT NOT NULL, accepted_at BIGINT, arrived_at BIGINT, started_at BIGINT,
    completed_at BIGINT, cancelled_at BIGINT, cancelled_by TEXT, cancel_reason TEXT,
    rating INTEGER
  );
  CREATE INDEX IF NOT EXISTS rides_status ON rides(status);
  CREATE INDEX IF NOT EXISTS rides_passenger ON rides(passenger_id);
  CREATE INDEX IF NOT EXISTS rides_driver ON rides(driver_id);
  CREATE TABLE IF NOT EXISTS ride_offers (
    ride_id BIGINT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    driver_id BIGINT NOT NULL, offered_at BIGINT NOT NULL, declined BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (ride_id, driver_id)
  );
  CREATE TABLE IF NOT EXISTS sos (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    ride_id BIGINT REFERENCES rides(id),
    lat DOUBLE PRECISION, lng DOUBLE PRECISION, accuracy DOUBLE PRECISION, message TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL, resolved_at BIGINT, resolved_note TEXT
  );
  -- Live updates: clients poll /api/events for rows addressed to them (works on serverless hosts).
  CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    target TEXT NOT NULL,
    type TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_target ON events(target, id);
  CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
  CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO kv (key, value) VALUES ('last_tick', '0') ON CONFLICT (key) DO NOTHING;
  INSERT INTO fares (vehicle,name,base,per_km,per_min,min_fare,active,sort) VALUES
    ('bike','Bike',15,6,0.5,25,TRUE,1), ('auto','Auto',25,11,1,35,TRUE,2),
    ('cab','Cab',50,15,1.5,80,TRUE,3), ('pink','Pink Cab',55,16,1.5,90,TRUE,4)
  ON CONFLICT (vehicle) DO NOTHING;
  -- Platform commission: per vehicle type, a flat ₹ amount or a % of the fare, charged per completed ride.
  ALTER TABLE fares ADD COLUMN IF NOT EXISTS commission_type TEXT NOT NULL DEFAULT 'flat';
  ALTER TABLE fares ADD COLUMN IF NOT EXISTS commission_value DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS commission DOUBLE PRECISION NOT NULL DEFAULT 0;
  -- Riders pay their commission to the admin's UPI ID and report the UPI reference (UTR); the admin confirms it.
  CREATE TABLE IF NOT EXISTS commission_payments (
    id BIGSERIAL PRIMARY KEY,
    driver_id BIGINT NOT NULL REFERENCES users(id),
    amount DOUBLE PRECISION NOT NULL,
    utr TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
    created_at BIGINT NOT NULL, reviewed_at BIGINT, note TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS commission_payments_utr ON commission_payments (UPPER(utr));
  CREATE INDEX IF NOT EXISTS commission_payments_driver ON commission_payments (driver_id, status);
  -- Pricing v2: base fare covers the first included_km; platform fee per ride (see src/pricing.js).
  ALTER TABLE fares ADD COLUMN IF NOT EXISTS included_km DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE fares ADD COLUMN IF NOT EXISTS platform_fee DOUBLE PRECISION NOT NULL DEFAULT 0;
  -- Fare breakdown, long-pickup surcharge, night premium and gridlock tracking per ride.
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS upfront_fare DOUBLE PRECISION;
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS platform_fee DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_km DOUBLE PRECISION;
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_surcharge DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS night BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS breakdown JSONB;
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS gridlock JSONB;
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS tier TEXT;
  -- Rider subscription passes (Tier 2 half-day, Tier 3 full-day). Tier 1 = pay per ride (rides.commission).
  CREATE TABLE IF NOT EXISTS driver_passes (
    id BIGSERIAL PRIMARY KEY,
    driver_id BIGINT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('half','full')),
    price DOUBLE PRECISION NOT NULL,
    starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL, created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS driver_passes_driver ON driver_passes (driver_id, ends_at);
  -- One-time switch of bike/auto to the v2 rate card (admin can edit afterwards).
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM kv WHERE key = 'ratecard_v2') THEN
      UPDATE fares SET base = 20, included_km = 2, per_km = 7, per_min = 0.5, platform_fee = 2, min_fare = 0 WHERE vehicle = 'bike';
      UPDATE fares SET base = 30, included_km = 1.5, per_km = 11, per_min = 0.75, platform_fee = 3, min_fare = 0 WHERE vehicle = 'auto';
      INSERT INTO kv (key, value) VALUES ('ratecard_v2', '1') ON CONFLICT (key) DO NOTHING;
    END IF;
  END $$;
  -- Service regions: the admin decides where in India SafeShe is reachable (active) or not yet (inactive).
  -- A ride's pickup and drop must both be inside the same active region (a circle around the city centre).
  CREATE TABLE IF NOT EXISTS regions (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT '',
    lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
    radius_km DOUBLE PRECISION NOT NULL DEFAULT 25,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS regions_name ON regions (LOWER(name));
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM kv WHERE key = 'regions_seeded') THEN
      INSERT INTO regions (name, state, lat, lng, radius_km, active, sort, created_at) VALUES
        ('Bengaluru', 'Karnataka', 12.9716, 77.5946, 35, TRUE, 1, 0),
        ('Delhi NCR', 'Delhi', 28.6139, 77.2090, 45, TRUE, 2, 0),
        ('Mumbai', 'Maharashtra', 19.0760, 72.8777, 40, TRUE, 3, 0),
        ('Hyderabad', 'Telangana', 17.3850, 78.4867, 35, TRUE, 4, 0),
        ('Chennai', 'Tamil Nadu', 13.0827, 80.2707, 35, TRUE, 5, 0),
        ('Kolkata', 'West Bengal', 22.5726, 88.3639, 30, TRUE, 6, 0),
        ('Pune', 'Maharashtra', 18.5204, 73.8567, 30, TRUE, 7, 0),
        ('Ahmedabad', 'Gujarat', 23.0225, 72.5714, 30, TRUE, 8, 0),
        ('Jaipur', 'Rajasthan', 26.9124, 75.7873, 25, TRUE, 9, 0),
        ('Lucknow', 'Uttar Pradesh', 26.8467, 80.9462, 25, TRUE, 10, 0),
        ('Kochi', 'Kerala', 9.9312, 76.2673, 25, TRUE, 11, 0),
        ('Chandigarh', 'Chandigarh', 30.7333, 76.7794, 20, TRUE, 12, 0),
        ('Bhubaneswar', 'Odisha', 20.2961, 85.8245, 20, TRUE, 13, 0),
        ('Indore', 'Madhya Pradesh', 22.7196, 75.8577, 20, TRUE, 14, 0),
        ('Patna', 'Bihar', 25.5941, 85.1376, 20, TRUE, 15, 0)
      ON CONFLICT DO NOTHING;
      INSERT INTO kv (key, value) VALUES ('regions_seeded', '1') ON CONFLICT (key) DO NOTHING;
    END IF;
  END $$;
  -- Ride payments: passengers pay the rider (rider's own UPI ID or cash); riders then pay SafeShe's share
  -- (platform fee + Fares minimum) to the admin's UPI ID for that ride.
  ALTER TABLE drivers ADD COLUMN IF NOT EXISTS upi_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS collected_at BIGINT;
  ALTER TABLE commission_payments ADD COLUMN IF NOT EXISTS ride_id BIGINT;
  -- Auto-verification: money-received alerts from the admin's bank SMS (parsed: amount + UPI reference only,
  -- the SMS text itself is not stored). A rider's payment is confirmed when UTR and amount match.
  CREATE TABLE IF NOT EXISTS bank_alerts (
    id BIGSERIAL PRIMARY KEY, utr TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL, vpa TEXT, source TEXT,
    received_at BIGINT NOT NULL, created_at BIGINT NOT NULL, payment_id BIGINT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS bank_alerts_utr ON bank_alerts (utr);
  -- Place-search cache shared by all server instances (same search = instant answer).
  CREATE TABLE IF NOT EXISTS geo_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at BIGINT NOT NULL);
`;

function connectionString(env) {
  let s = env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_PRISMA_URL || '';
  if (!s) {
    // Vercel's Storage integration can add a custom prefix (e.g. STORAGE_DATABASE_URL, NEON_POSTGRES_URL).
    const key = Object.keys(env).sort().find(k => /_(DATABASE_URL|POSTGRES_URL)$/.test(k) && /^postgres(ql)?:\/\//.test(env[k] || ''));
    if (key) s = env[key];
  }
  if (!s) throw new Error('Database not connected: DATABASE_URL is not set. In Vercel open Storage → Neon → Connect to this project (all environments), then Deployments → Redeploy.');
  return s;
}

function createDb(env = process.env) {
  // Serverless functions run many small instances, so keep each pool small.
  // The pool is created on first use, so a missing DATABASE_URL gives a clear error message
  // instead of crashing the whole function at startup.
  let pool = null;
  function getPool() {
    if (!pool) {
      const cs = connectionString(env); // throws a readable error if not configured
      const needsSsl = /neon\.tech|supabase|render\.com|amazonaws|sslmode=require/.test(cs) && !/sslmode=disable/.test(cs);
      pool = new pg.Pool({ connectionString: cs, max: +env.DB_POOL_MAX || 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
      pool.on('error', () => {}); // idle client errors (e.g. the provider closing connections) must not crash the function
    }
    return pool;
  }
  let ready = null;
  const db = {
    get pool() { return getPool(); },
    async q(sql, params) { await db.ready(); return (await getPool().query(sql, params)).rows; },
    async one(sql, params) { return (await db.q(sql, params))[0] || null; },
    async exec(sql, params) { await db.ready(); return (await getPool().query(sql, params)).rowCount; },
    ready() {
      if (!ready) ready = Promise.resolve().then(() => getPool().query(SCHEMA)).catch(e => { ready = null; throw e; });
      return ready;
    },
    close() { return pool ? pool.end() : Promise.resolve(); },
  };
  return db;
}

module.exports = { createDb };
