package com.safeshe.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.Vibrator;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * SafeShe: a WebView UI (assets/index.html) backed by native Android features:
 *  1. Voice recording  - MediaRecorder / MediaPlayer, saved to Downloads/SafeShe.
 *  2. Interruption detection - onPause/onResume tell the page how long the app was away.
 *  3. Emergency location sharing - LocationManager fix + SMS composer / share sheet.
 */
public class MainActivity extends Activity {

    static final class BuildInfo { static final String VERSION = "3.8"; }

    private static final int REQ_AUDIO = 1;
    private static final int REQ_LOCATION = 2;
    private static final int REQ_STORAGE = 3;
    private static final long LOCATION_TIMEOUT_MS = 10000;

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;

    private MediaRecorder recorder;
    private MediaPlayer player;
    private File currentRecording;
    private long recordStart;

    private long pausedAt = 0;
    private boolean pageReady = false;

    private LocationManager locationManager;
    private LocationListener activeListener;
    private Runnable locationTimeout;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("safeshe", MODE_PRIVATE);
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowContentAccess(false);
        s.setAllowFileAccess(true); // needed for file:///android_asset only
        s.setMediaPlaybackRequiresUserGesture(true);
        // Identify the app to OpenStreetMap/Nominatim/OSRM as their usage policies require.
        s.setUserAgentString(s.getUserAgentString() + " SafeShe/" + BuildInfo.VERSION + " (com.safeshe.app)");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("file:///android_asset/")) return false;
                openExternal(Uri.parse(url));
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "Android");
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    // ---------------------------------------------------------------- lifecycle (feature 2)

    @Override
    protected void onPause() {
        super.onPause();
        pausedAt = SystemClock.elapsedRealtime();
        pauseWatch(); // save battery; the last fix stays cached by Android
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (watchWanted) startWatch();
        // The page decides whether to show a check (always-on monitor or an active ride).
        if (pausedAt > 0 && pageReady) {
            long away = SystemClock.elapsedRealtime() - pausedAt;
            js("window.SafeShe && SafeShe.onAppResumed(" + away + ")");
        }
        pausedAt = 0;
    }

    @Override
    protected void onDestroy() {
        stopRecorderQuietly();
        stopPlayerQuietly();
        cancelLocation();
        pauseWatch();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web == null || !pageReady) { super.onBackPressed(); return; }
        web.evaluateJavascript("window.SafeShe && SafeShe.back ? SafeShe.back() : false",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String handled) {
                        if (!"true".equals(handled)) moveTaskToBack(true); // keep ride state alive
                    }
                });
    }

    // ---------------------------------------------------------------- helpers

    private void js(final String code) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (web != null) web.evaluateJavascript(code, null);
            }
        });
    }

    private void emit(String event, JSONObject data) {
        js("window.SafeShe && SafeShe.onNative(" + JSONObject.quote(event) + ","
                + (data == null ? "{}" : data.toString()) + ")");
    }

    private static JSONObject obj(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
        } catch (Exception ignored) {
        }
        return o;
    }

    private boolean has(String perm) {
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    private void openExternal(Uri uri) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            emit("toast", obj("message", "No app can open this link."));
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        boolean granted = results.length > 0;
        for (int r : results) granted &= (r == PackageManager.PERMISSION_GRANTED);
        if (code == REQ_AUDIO) {
            if (granted) startRecording();
            else emit("recError", obj("message", "Microphone permission was denied."));
        } else if (code == REQ_LOCATION) {
            // Coarse-only grant is still usable.
            if (has(Manifest.permission.ACCESS_COARSE_LOCATION) || has(Manifest.permission.ACCESS_FINE_LOCATION))
            { fetchLocation(); if (watchWanted) startWatch(); }
            else emit("locError", obj("message", "Location permission was denied."));
        } else if (code == REQ_STORAGE) {
            if (granted) saveRecording();
            else emit("saveResult", obj("ok", false, "message", "Storage permission was denied."));
        }
    }

    // ---------------------------------------------------------------- feature 1: recording

    private void startRecording() {
        if (recorder != null) return;
        if (!has(Manifest.permission.RECORD_AUDIO)) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
            return;
        }
        stopPlayerQuietly();
        String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
        File f = new File(getFilesDir(), "SafeShe_" + stamp + ".m4a");
        MediaRecorder r = new MediaRecorder();
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC);
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            r.setAudioSamplingRate(44100);
            r.setAudioEncodingBitRate(96000);
            r.setOutputFile(f.getAbsolutePath());
            r.prepare();
            r.start();
        } catch (Exception e) {
            r.release();
            f.delete();
            emit("recError", obj("message", "Could not start recording: " + e.getMessage()));
            return;
        }
        if (currentRecording != null) currentRecording.delete(); // only keep the latest unsaved take
        recorder = r;
        currentRecording = f;
        recordStart = SystemClock.elapsedRealtime();
        emit("recStarted", obj("file", f.getName()));
    }

    private void stopRecording() {
        if (recorder == null) return;
        long ms = SystemClock.elapsedRealtime() - recordStart;
        boolean ok = true;
        try {
            recorder.stop();
        } catch (RuntimeException e) {
            ok = false; // stop() throws if no audio was captured (e.g. stopped instantly)
        }
        recorder.release();
        recorder = null;
        if (!ok) {
            if (currentRecording != null) currentRecording.delete();
            currentRecording = null;
            emit("recError", obj("message", "Recording was too short. Please try again."));
            return;
        }
        emit("recStopped", obj("file", currentRecording.getName(), "durationMs", ms,
                "bytes", currentRecording.length()));
    }

    private void stopRecorderQuietly() {
        if (recorder != null) {
            try { recorder.stop(); } catch (RuntimeException ignored) { }
            recorder.release();
            recorder = null;
        }
    }

    private void play() {
        if (currentRecording == null || !currentRecording.exists()) {
            emit("recError", obj("message", "No recording to play yet."));
            return;
        }
        stopPlayerQuietly();
        MediaPlayer p = new MediaPlayer();
        try {
            p.setDataSource(currentRecording.getAbsolutePath());
            p.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override
                public void onCompletion(MediaPlayer mp) {
                    stopPlayerQuietly();
                    emit("playStopped", null);
                }
            });
            p.prepare();
            p.start();
            player = p;
            emit("playStarted", obj("durationMs", p.getDuration()));
        } catch (Exception e) {
            p.release();
            emit("recError", obj("message", "Could not play recording: " + e.getMessage()));
        }
    }

    private void stopPlayerQuietly() {
        if (player != null) {
            try { player.stop(); } catch (RuntimeException ignored) { }
            player.release();
            player = null;
        }
    }

    private void saveRecording() {
        if (currentRecording == null || !currentRecording.exists()) {
            emit("saveResult", obj("ok", false, "message", "No recording to save yet."));
            return;
        }
        String name = currentRecording.getName();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                // MediaStore.Downloads (API 29) referenced by value so this builds against API 23.
                ContentResolver cr = getContentResolver();
                ContentValues v = new ContentValues();
                v.put("_display_name", name);
                v.put("mime_type", "audio/mp4");
                v.put("relative_path", Environment.DIRECTORY_DOWNLOADS + "/SafeShe");
                Uri uri = cr.insert(Uri.parse("content://media/external/downloads"), v);
                if (uri == null) throw new IllegalStateException("MediaStore refused the file");
                OutputStream out = cr.openOutputStream(uri);
                copy(new FileInputStream(currentRecording), out);
            } else {
                if (!has(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
                    return;
                }
                File dir = new File(Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS), "SafeShe");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Cannot create folder");
                File dest = new File(dir, name);
                copy(new FileInputStream(currentRecording), new FileOutputStream(dest));
                MediaScannerConnection.scanFile(this, new String[]{dest.getAbsolutePath()},
                        new String[]{"audio/mp4"}, null);
            }
            emit("saveResult", obj("ok", true, "message", "Saved to Downloads/SafeShe/" + name));
        } catch (Exception e) {
            emit("saveResult", obj("ok", false, "message", "Save failed: " + e.getMessage()));
        }
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        try {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            in.close();
            if (out != null) out.close();
        }
    }

    // ---------------------------------------------------------------- feature 3: location

    /** Best cached fix across providers, or null. */
    private Location bestLastKnown() {
        Location best = null;
        try {
            for (String p : locationManager.getProviders(true)) {
                Location l = locationManager.getLastKnownLocation(p);
                if (l == null) continue;
                // Prefer newer fixes; among fixes < 30 s apart prefer the more accurate one.
                if (best == null || l.getTime() > best.getTime() + 30000
                        || (Math.abs(l.getTime() - best.getTime()) <= 30000 && l.getAccuracy() < best.getAccuracy()))
                    best = l;
            }
        } catch (SecurityException ignored) {
        }
        return best;
    }

    private boolean hasLocationPermission() {
        return has(Manifest.permission.ACCESS_FINE_LOCATION) || has(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    /**
     * Fast two-stage fix: the cached position is sent to the page immediately (no waiting),
     * then a fresh fix replaces it as soon as one arrives (max LOCATION_TIMEOUT_MS).
     */
    private void fetchLocation() {
        if (!hasLocationPermission()) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
            return;
        }
        cancelLocation();
        final Location lastKnown = bestLastKnown();
        if (lastKnown != null) {
            long age = System.currentTimeMillis() - lastKnown.getTime();
            sendLocation(lastKnown, age > 120000);
            if (age < 30000) return; // fresh enough: done instantly
        }
        boolean fine = has(Manifest.permission.ACCESS_FINE_LOCATION);
        String provider = null;
        if (fine && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) provider = LocationManager.GPS_PROVIDER;
        else if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) provider = LocationManager.NETWORK_PROVIDER;
        if (provider == null) {
            if (lastKnown == null) emit("locError", obj("message", "Location is turned off. Turn on Location in phone settings."));
            return;
        }
        emit("locPending", obj("provider", provider));
        activeListener = new LocationListener() {
            @Override public void onLocationChanged(Location l) { cancelLocation(); sendLocation(l, false); }
            @Override public void onStatusChanged(String p, int s, Bundle b) { }
            @Override public void onProviderEnabled(String p) { }
            @Override public void onProviderDisabled(String p) { }
        };
        try {
            locationManager.requestSingleUpdate(provider, activeListener, Looper.getMainLooper());
            // Network fixes usually arrive in 1-3 s; ask for one too when GPS is the main provider.
            if (LocationManager.GPS_PROVIDER.equals(provider)
                    && locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
                locationManager.requestSingleUpdate(LocationManager.NETWORK_PROVIDER, activeListener, Looper.getMainLooper());
        } catch (SecurityException e) {
            emit("locError", obj("message", "Location permission missing."));
            return;
        }
        locationTimeout = new Runnable() {
            @Override
            public void run() {
                cancelLocation();
                if (lastKnown == null) emit("locError", obj("message", "Could not get a location fix. Try near a window or outdoors."));
            }
        };
        ui.postDelayed(locationTimeout, LOCATION_TIMEOUT_MS);
    }

    // ---------------------------------------------------------------- continuous tracking while the app is open

    private boolean watchWanted = false;
    private LocationListener watchListener;

    private void startWatch() {
        watchWanted = true;
        if (watchListener != null || !hasLocationPermission()) return;
        watchListener = new LocationListener() {
            @Override public void onLocationChanged(Location l) { sendLocation(l, false); }
            @Override public void onStatusChanged(String p, int s, Bundle b) { }
            @Override public void onProviderEnabled(String p) { }
            @Override public void onProviderDisabled(String p) { }
        };
        try {
            boolean any = false;
            if (has(Manifest.permission.ACCESS_FINE_LOCATION) && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000, 5, watchListener, Looper.getMainLooper());
                any = true;
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 10000, 10, watchListener, Looper.getMainLooper());
                any = true;
            }
            if (!any) watchListener = null;
        } catch (SecurityException e) {
            watchListener = null;
        }
    }

    /** Stops updates (e.g. when the app goes to the background) but remembers that tracking is wanted. */
    private void pauseWatch() {
        if (watchListener != null) {
            try { locationManager.removeUpdates(watchListener); } catch (SecurityException ignored) { }
            watchListener = null;
        }
    }

    private void cancelLocation() {
        if (activeListener != null) {
            try { locationManager.removeUpdates(activeListener); } catch (SecurityException ignored) { }
            activeListener = null;
        }
        if (locationTimeout != null) {
            ui.removeCallbacks(locationTimeout);
            locationTimeout = null;
        }
    }

    private void sendLocation(Location l, boolean stale) {
        emit("location", obj("lat", l.getLatitude(), "lng", l.getLongitude(),
                "accuracy", l.hasAccuracy() ? (double) l.getAccuracy() : -1.0,
                "time", l.getTime(), "stale", stale));
    }

    // ---------------------------------------------------------------- JS bridge

    private class Bridge {
        @JavascriptInterface public boolean isNative() { return true; }

        @JavascriptInterface public void startRecording() { ui.post(new Runnable() { public void run() { MainActivity.this.startRecording(); } }); }
        @JavascriptInterface public void stopRecording() { ui.post(new Runnable() { public void run() { MainActivity.this.stopRecording(); } }); }
        @JavascriptInterface public void play() { ui.post(new Runnable() { public void run() { MainActivity.this.play(); } }); }
        @JavascriptInterface public void stopPlayback() { ui.post(new Runnable() { public void run() { stopPlayerQuietly(); emit("playStopped", null); } }); }
        @JavascriptInterface public void saveRecording() { ui.post(new Runnable() { public void run() { MainActivity.this.saveRecording(); } }); }

        @JavascriptInterface public void startWatch() { ui.post(new Runnable() { public void run() { MainActivity.this.startWatch(); } }); }
        @JavascriptInterface public void stopWatch() { ui.post(new Runnable() { public void run() { watchWanted = false; pauseWatch(); } }); }
        @JavascriptInterface public void getLocation() { ui.post(new Runnable() { public void run() { fetchLocation(); } }); }

        @JavascriptInterface public void setMonitor(boolean on) { prefs.edit().putBoolean("monitor", on).apply(); }
        @JavascriptInterface public boolean getMonitor() { return prefs.getBoolean("monitor", false); }

        @JavascriptInterface public void setPref(String key, String value) { prefs.edit().putString("p_" + key, value).apply(); }
        @JavascriptInterface public String getPref(String key) { return prefs.getString("p_" + key, ""); }

        @JavascriptInterface public void vibrate(long ms) {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) v.vibrate(Math.min(ms, 1000));
        }

        @JavascriptInterface public void sendSms(final String phone, final String text) {
            ui.post(new Runnable() {
                public void run() {
                    Intent i = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(phone == null ? "" : phone)));
                    i.putExtra("sms_body", text);
                    try { startActivity(i); }
                    catch (ActivityNotFoundException e) { emit("toast", obj("message", "No SMS app found. Use Share instead.")); }
                }
            });
        }

        @JavascriptInterface public void share(final String text) {
            ui.post(new Runnable() {
                public void run() {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(i, "Share emergency alert"));
                }
            });
        }

        @JavascriptInterface public void keepScreenOn(final boolean on) {
            ui.post(new Runnable() {
                public void run() {
                    // Riders who are online keep the screen on so ride requests and location updates continue.
                    if (on) getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface public void dial(final String number) {
            ui.post(new Runnable() {
                public void run() {
                    // ACTION_DIAL opens the dialer with the number filled in; the user presses call.
                    try { startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number)))); }
                    catch (ActivityNotFoundException e) { emit("toast", obj("message", "No phone app found. Dial " + number + " manually.")); }
                }
            });
        }

        @JavascriptInterface public void openUrl(final String url) {
            ui.post(new Runnable() { public void run() { openExternal(Uri.parse(url)); } });
        }
    }
}
