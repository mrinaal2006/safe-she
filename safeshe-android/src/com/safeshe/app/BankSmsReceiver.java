package com.safeshe.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Telephony;
import android.telephony.SmsMessage;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Admin's phone only (switched on in Admin → Payments): forwards bank "money received" SMS to the SafeShe server,
 * which confirms the rider payment with the same UPI reference and amount. Other SMS are never read further or sent.
 */
public class BankSmsReceiver extends BroadcastReceiver {
    static final String PREF_ON = "bank_watch", PREF_SERVER = "bank_watch_server", PREF_TOKEN = "bank_watch_token";
    private static final Pattern CREDIT = Pattern.compile("(?i)\\b(credited|received|deposited|added to)\\b");
    private static final Pattern AMOUNT = Pattern.compile("(?i)(rs\\.?|inr|₹)\\s*[0-9]");
    private static final Pattern REF = Pattern.compile("(?<![0-9])[0-9]{12}(?![0-9])");

    static boolean looksLikeCredit(String body) {
        return body != null && body.length() <= 1000 && CREDIT.matcher(body).find() && AMOUNT.matcher(body).find() && REF.matcher(body).find();
    }

    @Override public void onReceive(Context ctx, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
        final SharedPreferences prefs = ctx.getSharedPreferences("safeshe", Context.MODE_PRIVATE);
        if (!prefs.getBoolean(PREF_ON, false)) return;
        final String server = prefs.getString(PREF_SERVER, ""), token = prefs.getString(PREF_TOKEN, "");
        if (server.isEmpty() || token.isEmpty()) return;
        SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (parts == null) return;
        // A long SMS arrives in parts: join them per sender.
        final Map<String, StringBuilder> bodies = new LinkedHashMap<>();
        long at = System.currentTimeMillis();
        for (SmsMessage m : parts) {
            if (m == null) continue;
            String from = String.valueOf(m.getOriginatingAddress());
            if (!bodies.containsKey(from)) bodies.put(from, new StringBuilder());
            bodies.get(from).append(m.getMessageBody());
            at = m.getTimestampMillis();
        }
        final long when = at;
        final PendingResult pending = goAsync();
        new Thread(new Runnable() { public void run() {
            try {
                for (StringBuilder b : bodies.values()) {
                    String body = b.toString();
                    if (looksLikeCredit(body)) post(prefs, server, token, body, when);
                }
            } finally { pending.finish(); }
        } }).start();
    }

    private static void post(SharedPreferences prefs, String server, String token, String body, long at) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(server + "/api/admin/bank-alerts").openConnection();
            c.setConnectTimeout(15000); c.setReadTimeout(15000); c.setDoOutput(true); c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + token);
            JSONObject j = new JSONObject(); j.put("text", body); j.put("source", "sms"); j.put("at", at);
            OutputStream o = c.getOutputStream(); o.write(j.toString().getBytes("UTF-8")); o.close();
            int code = c.getResponseCode();
            // Logged out or no longer admin: stop forwarding until the admin switches it on again.
            if (code == 401 || code == 403) prefs.edit().putBoolean(PREF_ON, false).remove(PREF_TOKEN).apply();
        } catch (Exception ignored) {
            // No connection: the admin can still confirm this payment by hand (or paste the SMS) in Admin → Payments.
        } finally { if (c != null) c.disconnect(); }
    }
}
