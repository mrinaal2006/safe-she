# SafeShe Rides

A bike, auto and cab booking app with women's-safety features built in. It has three roles:
- **Passenger:** logs in with phone + SMS OTP, books rides, tracks the rider live, and has SOS, a trip monitor and voice recording.
- **Rider (captain):** registers a vehicle, is approved by the admin, goes online and accepts rides (pickup OTP to start).
- **Admin:** dashboard with live SOS alerts, rider approval, users, rides, fares, service regions, and SMS status and settings.

**Service regions:** the admin decides where in India SafeShe is reachable (Admin → **Regions**). 15 major cities are
included and switched on to start: Bengaluru, Delhi NCR, Mumbai, Hyderabad, Chennai, Kolkata, Pune, Ahmedabad, Jaipur,
Lucknow, Kochi, Chandigarh, Bhubaneswar, Indore and Patna. The admin can switch any city to **not reachable** (shown
as "Coming soon"), change its radius, or add a new region (with **Find** to look up the city centre). Passengers' region
is detected from GPS, or they choose it with the 📍 region button. Destination search then shows places **inside that
region**. A ride is accepted only when pickup and drop are both inside the same reachable region.

**Reports (PDF):** Admin → **Reports**: choose **Last 7 days**, **Last 90 days** or **Custom dates** (up to 366 days),
see a summary on screen, and tap **Download PDF report**. The PDF covers rides and completion rate, cancellations,
fares, SafeShe earnings (platform fees, minimum amounts, passes), UPI payments, new passengers and riders, SOS alerts, and
tables by vehicle type, region, day and top riders. Dates are India time. In the browser the PDF downloads normally; in the
Android app it is saved to **Downloads/SafeShe/**.

**Stay logged in:** after logging in once, the app stays logged in until **Log out**. Each use extends the login.
With no internet, the app shows "No connection" and reconnects by itself without asking you to log in again.

**Free maps:** the map is **OpenFreeMap** (free vector map: no key, no registration, no usage limits, commercial use
allowed), drawn with MapLibre. Devices without WebGL fall back to OpenStreetMap tiles. Place search uses Photon (free,
made for search-as-you-type), with Nominatim as a fallback. To use another provider later, set `TILE_STYLE` (vector)
or `TILE_URL` (raster) on the server.

| Folder | What it is |
|---|---|
| `api/`, `vercel.json`, `package.json` | Vercel deployment from the repository root |
| [`safeshe-server/`](safeshe-server/README.md) | Server code (Express + Postgres) and its tests |
| [`safeshe-android/`](safeshe-android/README.md) | Android app (WebView app + native recording, location, SMS, dialling) |
| `outputs/SafeShe-4.7.apk` | Latest signed APK. It connects to the built-in server address. |

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
2. Either paste it in **Admin → Settings → Login OTP delivery → Save & check key** (stored in the database, works for
   every deployment at once, no redeploy), or add it in Vercel as `TWOFACTOR_API_KEY` and **Redeploy**. The Vercel setting wins if both exist.
3. Log in to the admin panel → **Settings**. It shows "✅ SMS sending is active. Balance: …". Use **Send test SMS**
   to check delivery to your phone.

Without the key, the server runs in **test mode**: no SMS is sent, and the latest codes are shown in Admin → Settings.
If you registered your own DLT OTP template with 2Factor, set its name as `TWOFACTOR_TEMPLATE`.

## Pricing engine
**Upfront fare = Base fare + (Distance beyond the included km × Per-km rate) + (Traffic minutes × Per-minute rate) + Platform fee**

| | Base fare | Base covers | Per km after that | Per minute (gridlock only) | Platform fee |
|---|---|---|---|---|---|
| 🏍️ Bike | ₹20 | first 2 km | ₹7 | ₹0.50 | ₹2 |
| 🛺 Auto | ₹30 | first 1.5 km | ₹11 | ₹0.75 | ₹3 |
| 🚗 Cab / Pink Cab | ₹50 / ₹55 | — | ₹15 / ₹16 | ₹1.50 | ₹0 |

- **Gridlock trigger:** the upfront fare has no time charge. During the trip, the server measures speed from the rider's
  GPS. The per-minute rate is charged only while the vehicle stays **below 8 km/h for more than 3 consecutive minutes**,
  and then the whole slow stretch is billed. GPS gaps longer than 2 minutes are never billed.
- **Long pickup surcharge:** if the rider is more than **2.5 km** from the passenger when accepting, **₹1.50 per extra km**
  is added to the fare. 100% goes to the rider, and the passenger sees it immediately.
- **Night premium:** **×1.25** on base + distance + traffic charges for rides booked **11 PM – 5 AM** (India time). The
  platform fee and pickup surcharge are not multiplied.
- The total is rounded to the nearest rupee. Every value is editable: **Admin → Fares** (rate card) and **Admin →
  Settings → Pricing & rider plans** (night, pickup, gridlock, tiers).

## Rider plans (instead of a % commission)
| Tier | Plan | Price |
|---|---|---|
| 1 · Casual | Pay per ride (default) | SafeShe's share on every ride: Platform fee + Minimum (Admin → Fares) |
| 2 · Part-time | Half-Day Pass | ₹15 for 6 hours, unlimited rides |
| 3 · Full-time | Full-Day Pass | ₹29 for 24 hours, unlimited rides |

Riders buy a pass from their home screen and it starts immediately. A ride counts under a pass if it was accepted while
the pass was active, and then the Minimum is waived (only the platform fee is paid). Riders keep the whole fare except the passenger's **platform fee**, which they pass on to SafeShe.

## Ride payments (every ride)
1. **Passenger pays the rider.** If the passenger chose **UPI**, the finished-ride screen shows **Pay ₹X to [rider]**: a
   **Pay with UPI app** button and a **QR code** for the rider's own UPI ID, so the money goes straight to the rider's account.
   If they chose **cash**, it says how much to pay in cash.
2. **Rider collects.** After **Complete ride**, the rider sees their own **UPI QR code** with the exact fare (or "Collect ₹X
   cash") and taps **Payment received**.
3. **Rider pays SafeShe's share for that ride.** The share uses only the two values the admin sets per vehicle in
   **Admin → Fares**: **Platform fee ₹ + Minimum ₹ (SafeShe share)**. With the default rate card that is bike ₹2, auto ₹3,
   cab ₹80 and Pink Cab ₹90. While a pass is active the Minimum is waived and only the platform fee is due. The fare is
   never lower than the Minimum. The screen shows the admin's **UPI QR code** and a **Pay with UPI app** button. The rider
   then enters the **UTR**, and the admin confirms it in Admin → Payments. **Pay later** adds the amount to the rider's
   dues, and the dues limit can stop riders going online until they pay.

Riders add their **UPI ID** in rider registration or *My account → Edit my details*. Changing it doesn't need re-approval.

**"Payment declined for security reasons" in GPay/PhonePe?** UPI apps often block payment links that another app opens
when the receiver is a **personal** UPI ID. Every payment screen therefore also has **📋 Copy UPI ID** (pay to that UPI
ID inside the UPI app) and **🖼️ Save QR to gallery** (saved to **Pictures/SafeShe**; in the UPI app tap Scan → gallery
and pick it). A passenger can also scan the rider's QR with the camera. The lasting fix is a **business/merchant UPI ID**
(GPay for Business, PhonePe Business, Paytm Business, BharatPe): pay links to those are accepted.

## Paying SafeShe (admin's UPI ID)
What a rider owes = platform fees + Minimum amounts (Admin → Fares) + passes bought − confirmed payments.
1. Admin → **Settings → Payments (UPI)**: enter your UPI ID (e.g. `yourname@okaxis`) and the payee name.
   Optionally set a **dues limit**: riders who owe more than this can't go online until they pay.
2. The rider sees **"Due to SafeShe ₹X"** and taps **Pay via UPI**, which opens GPay/PhonePe/Paytm/BHIM with your UPI
   ID and the amount filled in.
3. After paying, the rider enters the **UPI reference (UTR)**. You check it in your bank/UPI app and press
   **Confirm received** in Admin → **Payments**. The rider is notified and the dues are cleared.

**Automatic verification (from your bank SMS).** A plain UPI ID can't tell the server that money arrived, but your
bank's "money received" SMS can. In the SafeShe Android app, log in as admin on the phone that receives your bank's
SMS, open **Payments** and switch on **Read bank SMS**. When an SMS with "credited/received", an amount and a 12-digit
UPI reference arrives, the app sends it to the server, which keeps only the amount, UTR and sender UPI ID. A rider's
payment with the **same UTR and amount** is then confirmed automatically (whichever comes first, the SMS or the rider's
UTR). Anything that doesn't match stays pending for you. Other SMS are ignored. You can also paste a bank SMS in
**Check this SMS** (works in the browser too). On Android 13+, if the SMS permission is blocked as a "restricted
setting": App info → ⋮ → **Allow restricted settings**, then switch it on again. (Idea inspired by the YouPI-PG
project; SafeShe's code is its own.) Some UPI apps limit "pay" links to personal UPI IDs;
a business/merchant UPI ID works best.

## Android app
Install `outputs/SafeShe-4.7.apk`. It connects to **https://safe-she-one.vercel.app** automatically, with no server
address to type. `./safeshe-android/build.sh` builds with that address by default. Set `SAFESHE_SERVER_URL=https://…`
to build for another server.

**Opening animation:** every time the app opens (and when you come back after more than a minute away), a short animation
plays: the shield draws in, the heart pops, SafeShe rises in and a scooter rides a route to the pin. It lasts about 2.5 s,
and you can tap to skip. It never plays during a ride or an emergency. It's drawn in SVG/CSS, so it works offline and is tiny.

The "Everything okay? / I'm safe" safety check after leaving the app is shown to **passengers only**, never to riders
or the admin.

## Develop / test
```bash
npm install
DATABASE_URL=postgres://… ADMIN_PASSWORD=… npm start      # http://localhost:8080
TEST_DATABASE_URL=postgres://…/throwaway npm test          # 46 end-to-end checks (drops that DB's tables)
```
