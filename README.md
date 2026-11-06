# SafeShe Rides

A bike, auto and cab booking app with women's-safety features built in. It has three roles:
- **Passenger:** logs in with phone + SMS OTP, books rides, tracks the rider live, and has SOS, a trip monitor and voice recording.
- **Rider (captain):** registers a vehicle, is approved by the admin, goes online and accepts rides (pickup OTP to start).
- **Admin:** dashboard with live SOS alerts, rider approval, users, rides, fares, and SMS status and settings.

| Folder | What it is |
|---|---|
| `api/`, `vercel.json`, `package.json` | Vercel deployment from the repository root |
| [`safeshe-server/`](safeshe-server/README.md) | Server code (Express + Postgres) and its tests |
| [`safeshe-android/`](safeshe-android/README.md) | Android app (WebView app + native recording, location, SMS, dialling) |
| `outputs/SafeShe-3.3.apk` | Latest signed APK. It asks for the server address on first launch. |

## Deploy on Vercel
1. **Import:** vercel.com → **Add New → Project** → import `safe-she`.
   - **Root Directory: leave it as `./`** (the repository root). If you set it to `safeshe-server` before, clear it under
     Project → Settings → General → Root Directory.
   - Framework preset: **Other**. Leave Build/Output/Install settings empty or default; `vercel.json` provides them.
2. **Database:** Project → **Storage → Create Database → Neon (Postgres)** → **Connect** to this project, all environments.
   This adds `DATABASE_URL` / `POSTGRES_URL` automatically.
3. **Environment variables:** Project → **Settings → Environment Variables**:
   | Name | Value |
   |---|---|
   | `ADMIN_PASSWORD` | your admin password (username: `Administrator`) |
   | `TWOFACTOR_API_KEY` | your 2Factor.in API key: **needed for real SMS codes** |
   | `CONTACT_EMAIL` | your email (OpenStreetMap usage policy) |
4. **Deployments → ⋯ → Redeploy.** Environment variables only apply to new deployments.
5. Check `https://<project>.vercel.app/api/health`. It should show `{"ok":true,...}`. If it shows
   `DATABASE_URL is not set`, step 2 isn't connected yet.

## SMS login codes (2Factor.in)
1. Sign up at **2factor.in** and open **Dashboard → API Keys**. Copy your API key.
2. Add it in Vercel as `TWOFACTOR_API_KEY`, then **Redeploy**.
3. Log in to the admin panel → **Settings**. It shows "✅ SMS sending is active. Balance: …". Use **Send test SMS**
   to check delivery to your phone.

Without the key, the server runs in **test mode**: no SMS is sent, and the latest codes are shown in Admin → Settings.
If you registered your own DLT OTP template with 2Factor, set its name as `TWOFACTOR_TEMPLATE`.

## Android app
Install `outputs/SafeShe-3.3.apk` and enter `https://<project>.vercel.app` on first launch, or build it with the
address built in: `SAFESHE_SERVER_URL=https://<project>.vercel.app ./safeshe-android/build.sh`.

## Develop / test
```bash
npm install
DATABASE_URL=postgres://… ADMIN_PASSWORD=… npm start      # http://localhost:8080
TEST_DATABASE_URL=postgres://…/throwaway npm test          # 30 end-to-end checks (drops that DB's tables)
```
