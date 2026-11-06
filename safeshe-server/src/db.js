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
`;

function connectionString(env) {
  const s = env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_PRISMA_URL || '';
  if (!s) throw new Error('DATABASE_URL is not set. Add a Postgres database (for example Vercel → Storage → Neon).');
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
