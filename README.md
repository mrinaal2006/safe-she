# SafeShe Rides

A bike, auto and cab booking app with women's-safety features built in. It has three roles:
- **Passenger:** logs in with phone + OTP, books rides, tracks the rider live, and has SOS, a trip monitor and voice recording.
- **Rider (captain):** registers a vehicle, is approved by the admin, goes online and accepts rides (pickup OTP to start).
- **Admin:** dashboard with live SOS alerts, rider approval, users, rides, fares and settings.

| Folder | What it is |
|---|---|
| [`safeshe-server/`](safeshe-server/README.md) | Backend and web app. **Deploy on Vercel + Neon Postgres** (steps in its README), or Render/Docker. |
| [`safeshe-android/`](safeshe-android/README.md) | Android app (WebView app + native recording, location, SMS, dialling). |
| `outputs/SafeShe-3.1.apk` | Latest signed APK. It asks for the server address on first launch. |
| `render.yaml` | Optional Render blueprint (web service + Postgres). |

## Quick start (Vercel)
1. Vercel → Add New → Project → import this repo → **Root Directory: `safeshe-server`**.
2. Storage → Create → **Neon** (Postgres) → connect to the project.
3. Environment variables: `ADMIN_PASSWORD` (admin username is `Administrator`) and `TWOFACTOR_API_KEY` (2Factor.in, optional; without it OTPs run in test mode).
4. Deploy, then open `https://<project>.vercel.app`.
5. Build the app for that address: `SAFESHE_SERVER_URL=https://<project>.vercel.app ./safeshe-android/build.sh`

Run the server tests with `TEST_DATABASE_URL=postgres://… npm test` inside `safeshe-server/`.
