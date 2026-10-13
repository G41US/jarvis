package com.jarvis.assistant;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.telephony.SmsManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;

/**
 * SOS: texts the user's emergency contacts their location now, then an updated location every 5 minutes for 30 minutes,
 * until they say "I'm safe" (which tells the same people). Runs natively, so it keeps going with Jarvis in the background.
 */
public final class SosManager {
    private static final String TAG = "JarvisSOS";
    private static final long EVERY_MS = 5 * 60_000L;
    private static final int UPDATES = 6;
    private static SosManager inst;
    private final Context ctx;
    private final Handler h = new Handler(Looper.getMainLooper());
    private JSONArray contacts = new JSONArray();
    private String who = "", note = "";
    private int sent = 0;
    private boolean active = false;

    private SosManager(Context c) { ctx = c.getApplicationContext(); }
    public static synchronized SosManager get(Context c) { if (inst == null) inst = new SosManager(c); return inst; }

    public boolean canText() { return ctx.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED; }
    public synchronized boolean active() { return active; }

    @SuppressWarnings("deprecation")
    private SmsManager sms() { return Build.VERSION.SDK_INT >= 31 ? ctx.getSystemService(SmsManager.class) : SmsManager.getDefault(); }

    private int textAll(String body) {
        int ok = 0;
        for (int i = 0; i < contacts.length(); i++) {
            JSONObject c = contacts.optJSONObject(i);
            String n = c == null ? "" : c.optString("number").replaceAll("[^\\d+]", "");
            if (n.isEmpty()) continue;
            try {
                SmsManager m = sms();
                ArrayList<String> parts = m.divideMessage(body);
                m.sendMultipartTextMessage(n, null, parts, null, null);
                ok++;
            } catch (Exception e) { Log.w(TAG, "sms to " + n, e); }
        }
        return ok;
    }

    private String place() {
        try {
            JSONObject l = new JSONObject(ShiftTracker.get(ctx).freshLocation(8000));
            if (!l.has("lat")) return "Location unavailable (GPS off).";
            String link = String.format(Locale.US, "https://maps.google.com/?q=%.6f,%.6f", l.getDouble("lat"), l.getDouble("lon"));
            long age = l.optLong("age_s", 0);
            return link + " (within " + Math.max(5, l.optInt("acc", 0)) + " m" + (age > 120 ? ", " + (age / 60) + " min ago" : "") + ")";
        } catch (Exception e) { return "Location unavailable."; }
    }

    private static String time() { return new SimpleDateFormat("h:mm a", Locale.US).format(new Date()); }

    /** -> {"sent": n, "contacts": n} or {"error": "sms" | "nocontacts"}. Blocks for up to ~8 s while getting a GPS fix. */
    public synchronized String start(String contactsJson, String name, String message) {
        try {
            contacts = new JSONArray(contactsJson == null ? "[]" : contactsJson);
            if (contacts.length() == 0) return "{\"error\":\"nocontacts\"}";
            if (!canText()) return "{\"error\":\"sms\"}";
            who = name == null || name.trim().isEmpty() ? "I" : name.trim();
            note = message == null ? "" : message.trim();
            active = true; sent = 0;
            h.removeCallbacksAndMessages(null);
            String body = "EMERGENCY: " + (who.equals("I") ? "I need help." : who + " needs help.") + (note.isEmpty() ? "" : " " + note)
                    + " Location " + time() + ": " + place() + " Updates every 5 min. (Sent by Jarvis)";
            int n = textAll(body);
            schedule();
            return new JSONObject().put("sent", n).put("contacts", contacts.length()).toString();
        } catch (Exception e) { Log.w(TAG, "start", e); return "{\"error\":\"failed\"}"; }
    }

    private void schedule() {
        h.postDelayed(new Runnable() {
            @Override public void run() {
                new Thread(new Runnable() { @Override public void run() {
                    synchronized (SosManager.this) {
                        if (!active) return;
                        sent++;
                        textAll("Update " + time() + " from " + (who.equals("I") ? "me" : who) + ": " + place());
                        if (sent < UPDATES) schedule(); else active = false;
                    }
                } }).start();
            }
        }, EVERY_MS);
    }

    /** "I'm safe": tells the same people and stops the updates. */
    public synchronized String stop(String message) {
        if (!active && contacts.length() == 0) return "{\"error\":\"none\"}";
        boolean was = active;
        active = false;
        h.removeCallbacksAndMessages(null);
        int n = was && canText() ? textAll(message == null || message.isEmpty() ? (who.equals("I") ? "I'm safe now." : who + " is safe now.") + " Thanks. (Jarvis)" : message) : 0;
        try { return new JSONObject().put("sent", n).put("was_active", was).toString(); } catch (Exception e) { return "{}"; }
    }

    /** One message with the current location to the given numbers (not an emergency). Returns how many went out. */
    public synchronized int shareLocation(String numbersJson, String text) {
        try {
            if (!canText()) return -1;
            JSONArray nums = new JSONArray(numbersJson);
            JSONArray save = contacts; contacts = new JSONArray();
            for (int i = 0; i < nums.length(); i++) contacts.put(new JSONObject().put("number", nums.getString(i)));
            int n = textAll((text == null || text.isEmpty() ? "Here's where I am" : text) + ": " + place());
            contacts = save;
            return n;
        } catch (Exception e) { return 0; }
    }

    /** The location line SOS messages use (for the composer fallback when Jarvis can't send texts himself). */
    public String placeText() { return place(); }
}
