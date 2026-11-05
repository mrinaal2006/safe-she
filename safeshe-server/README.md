# SafeShe server

Backend and web app for SafeShe Rides (`../safeshe-android`). Built for **Vercel + Postgres** (Neon), and also
runs as a normal Node server (local, Docker, Render, VPS).

- **API:** Express in one serverless function (`api/index.js` → `src/app.js`)
- **Database:** PostgreSQL (`DATABASE_URL` or `POSTGRES_URL`). Tables are created automatically on first request.
- **Live updates:** without long-lived connections. The server writes events to an `events` table and the app polls
  `/api/events` about every 2 seconds. Ride matching runs during those polls, at most once every 3 s across all instances.
- **Web app:** the same files as the Android app, copied to `public/` at build time. `/` is the app,
  `/admin` the admin login, and `/t/<token>` the live-trip page for emergency contacts.

## Deploy on Vercel (about 5 minutes)
1. **Import:** vercel.com → **Add New → Project** → import the GitHub repo `gamee2222`.
2. **Root Directory:** set it to **`safeshe-server`**. Leave "Include files outside the root directory" on; the build copies the
   app from `../safeshe-android/assets`. Framework preset: **Other**. The build settings come from `vercel.json`.
3. **Database:** Project → **Storage → Create → Neon (Postgres)** → connect it to the project. This adds `DATABASE_URL`/`POSTGRES_URL`.
4. **Environment variables** (Project → Settings → Environment Variables):
   - `ADMIN_PASSWORD`: your admin password (the username is `Administrator`)
   - `TWOFACTOR_API_KEY`: your 2Factor.in key (leave empty for test mode)
   - `CONTACT_EMAIL`: your email (OpenStreetMap usage policy)
5. **Deploy.** Your address is `https://<project>.vercel.app`. Open it: the app, the admin login and the API all live there.
6. **Build the Android app** pointing at it: `SAFESHE_SERVER_URL=https://<project>.vercel.app ./safeshe-android/build.sh`.

Vercel's free Hobby plan is for non-commercial use only. A ride business needs the **Pro** plan. Every app open
polls about every 2 s, so watch function usage as you grow.

## Run locally
```bash
cd safeshe-server
npm install
cp .env.example .env     # set DATABASE_URL and ADMIN_PASSWORD
npm start                # http://localhost:8080
TEST_DATABASE_URL=postgres://…/throwaway_db npm test   # 29 end-to-end checks (drops that DB's tables!)
```

## Other hosts
- **Render:** New → Blueprint → this repo (`/render.yaml` creates the web service and a Postgres database).
- **Docker/VPS:** `docker build -f safeshe-server/Dockerfile -t safeshe .` (from the repo root), then run with `-e DATABASE_URL=…`.

## Features
| Area | Details |
|---|---|
| Login | Passengers and riders: Indian mobile number + 6-digit OTP (5-minute expiry, single use, 5 attempts, 30 s resend gap, hourly limits per phone and IP). Admin: username + password (scrypt). |
| OTP SMS | 2Factor.in when `TWOFACTOR_API_KEY` is set. Otherwise test mode: codes are shown in Admin → Settings. |
| Roles | Passenger books. Rider registers a vehicle → admin approves → goes online → accepts rides. Admin controls everything. |
| Rides | Quotes from route distance and time. Live offers to approved, online riders of the right type within `DISPATCH_RADIUS_KM`, and the first to accept wins. Then pickup OTP → started → completed → rating. Unanswered rides expire after `SEARCH_TIMEOUT_SEC`. Pink Cab rides go only to female cab riders. |
| Safety | SOS alerts appear on the admin dashboard within about 2 s. Each ride has a public live-tracking link. |
| Search | Worldwide place search through the server (Nominatim, with Photon as fallback, cached). OSRM routes, with an estimate fallback. |
| Admin | Stats, SOS (call, map, live track, resolve), rider approval, users and blocking, rides and cancelling, fares, OTP test codes, password change. |

## Not included yet
Online payments (cash/UPI is recorded only), rider document uploads, push notifications when the app is closed,
background location for riders.
