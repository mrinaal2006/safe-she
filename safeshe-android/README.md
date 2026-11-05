# SafeShe Rides (Android) v3.0

Real ride-booking app with three roles: **Passenger**, **Rider** (captain) and **Admin**. Passengers and riders log in
with their phone number + OTP; the admin logs in with username and password. All rides, matching, live tracking and
SOS alerts go through the SafeShe server in `../safeshe-server` (see its README for setup and deployment).

Build with the server address baked in:
```
SAFESHE_SERVER_URL=https://your-server.example.com ./build.sh   # -> ../outputs/SafeShe-3.0.apk
```
Without `SAFESHE_SERVER_URL` the app asks for the server address on first launch.

## Safety features
| Feature | How it works |
|---|---|
| Voice recording | Safety centre, in-ride **Record** button, or SOS sheet. Microphone permission is asked on first use. M4A recording with play and **Download**, saved to `Downloads/SafeShe/`. |
| Interruption detection | The trip monitor turns on automatically during rides, or you can switch it on all the time in Safety centre. Leaving the app for 3 s or more and returning shows "Everything okay?". **I'm safe** closes it. **Prepare alert**, or 30 s with no answer, opens the SOS sheet. |
| Emergency location sharing | **Instant:** while SafeShe is open it tracks your location continuously (GPS every 5 s / 5 m, plus network), so SOS shows your position at once instead of waiting for a fix. **Press and hold SOS for 1 s** to open the alert SMS to your trusted contact in one gesture. A fresh fix still refines the alert in the background (10 s max). Tapping SOS opens the sheet: call 112, plus an alert with your Maps link and ride details by SMS or share. You can optionally auto-share the trip when a ride starts. |

## Permissions
`INTERNET` (SafeShe server, map tiles; plain http allowed only for testing on a local network), `RECORD_AUDIO`, `ACCESS_FINE/COARSE_LOCATION`, `VIBRATE`, `WRITE_EXTERNAL_STORAGE` (Android ≤ 9 only).

## Build
```
sudo apt-get install aapt dalvik-exchange zipalign apksigner android-sdk-platform-23 openjdk-21-jdk-headless
./build.sh            # -> ../outputs/SafeShe-<versionName>.apk
```
The signing key lives at `../work/keys/safeshe-release.jks` (git-ignored). Updates must use the same key.

## Files
- `assets/index.html`, `assets/app.css`, `assets/app.js`: passenger, rider and admin screens plus safety logic (the same files are served by the server as the web app)
- `assets/track.html`: public live-trip page for emergency contacts
- `assets/vendor/socket.io.min.js`: Socket.IO client 4.8 (MIT)
- `assets/vendor/leaflet/`: Leaflet 1.9.4 map library (BSD-2-Clause)
- `src/com/safeshe/app/MainActivity.java`: WebView host and native bridge (recording, location, SMS, share, dial, prefs)

## Known limitations
- No online payments yet: cash/UPI is recorded but no payment is collected in the app.
- Riders must keep SafeShe open while online. The screen stays on, but location and ride requests pause if the rider switches to another app (for example external navigation). A background location service is the next step.
- No push notifications when the app is closed.
- The map, search and routes need internet. Search and routes go through your server (cached and rate-limited) to public OpenStreetMap, Nominatim and OSRM servers, whose usage policies allow only light use. For heavy traffic, switch to your own or paid map providers.
- Android 9+ silences the microphone for apps in the background, so keep SafeShe on screen while recording.
- The safety check appears when you return to the app. There's no background service while you're away.
- Tracking stops while SafeShe is in the background (to save battery). After returning, the last known fix is shown at once and refreshed within seconds.
- SMS, sharing and 112 open your own apps for you to confirm. SafeShe never sends or calls by itself.
