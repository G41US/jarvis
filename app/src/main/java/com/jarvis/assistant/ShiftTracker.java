package com.jarvis.assistant;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Shift and mileage tracking for drivers: "start my shift" ... "end my shift". While a shift is on, the phone's GPS adds up
 * the miles driven (ignoring jitter while parked and impossible jumps), even with Jarvis in the background, and the shift is
 * saved to a trip log (date, times, miles) that can be exported for taxes. Also keeps the latest position for "where did I
 * park", SOS messages and "share my location".
 */
public final class ShiftTracker implements LocationListener {
    private static final String TAG = "JarvisShift", PREFS = "jarvis_shift";
    private static ShiftTracker inst;
    private final Context ctx;
    private Location last, lastGood;
    private boolean listening = false;

    private ShiftTracker(Context c) { ctx = c.getApplicationContext(); }
    public static synchronized ShiftTracker get(Context c) { if (inst == null) inst = new ShiftTracker(c); return inst; }

    private SharedPreferences prefs() { return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    private boolean hasPermission() { return ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED; }

    public synchronized boolean active() { return prefs().getBoolean("active", false); }

    /** Starts a shift (or keeps the one that's running). Returns the status JSON. */
    public synchronized String start() {
        if (!hasPermission()) return "{\"error\":\"location\"}";
        if (!active()) prefs().edit().putBoolean("active", true).putLong("start", System.currentTimeMillis()).putFloat("meters", 0f).putLong("moving_ms", 0).apply();
        listen(true);
        return status();
    }

    /** Ends the shift, saves it to the trip log and returns it. */
    public synchronized String end() {
        if (!active()) return "{\"error\":\"none\"}";
        long start = prefs().getLong("start", System.currentTimeMillis()), end = System.currentTimeMillis();
        float meters = prefs().getFloat("meters", 0f);
        JSONObject trip = new JSONObject();
        try {
            trip.put("start", start); trip.put("end", end); trip.put("meters", Math.round(meters)); trip.put("moving_ms", prefs().getLong("moving_ms", 0));
            JSONArray log = trips();
            log.put(trip);
            while (log.length() > 3000) log.remove(0);
            prefs().edit().putBoolean("active", false).putString("trips", log.toString()).apply();
        } catch (Exception e) { Log.w(TAG, "end", e); }
        listen(false);
        last = null;
        return trip.toString();
    }

    public synchronized String status() {
        JSONObject o = new JSONObject();
        try {
            o.put("active", active()); o.put("start", prefs().getLong("start", 0)); o.put("meters", Math.round(prefs().getFloat("meters", 0f)));
            o.put("moving_ms", prefs().getLong("moving_ms", 0)); o.put("gps", lastGood != null && System.currentTimeMillis() - lastGood.getTime() < 120_000);
        } catch (Exception ignored) { }
        return o.toString();
    }

    public synchronized JSONArray trips() {
        try { return new JSONArray(prefs().getString("trips", "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    /** Keeps tracking across an app restart (called when Jarvis starts). */
    public synchronized void resume() { if (active()) listen(true); }

    private void listen(boolean on) {
        LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return;
        try {
            if (on && !listening && hasPermission()) {
                if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 4000, 15f, this, Looper.getMainLooper());
                if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 15000, 50f, this, Looper.getMainLooper());
                listening = true;
            } else if (!on && listening) { lm.removeUpdates(this); listening = false; }
        } catch (SecurityException e) { Log.w(TAG, "listen", e); }
    }

    @Override public synchronized void onLocationChanged(Location l) {
        if (l == null) return;
        if (l.hasAccuracy() && l.getAccuracy() > 60) return;                       // too vague to count
        lastGood = l;
        if (!active()) return;
        if (last != null) {
            float d = last.distanceTo(l);
            long dt = Math.max(1, l.getTime() - last.getTime());
            float speed = d / (dt / 1000f);
            float noise = Math.max(10f, (l.hasAccuracy() ? l.getAccuracy() : 20f) + (last.hasAccuracy() ? last.getAccuracy() : 20f)) * 0.6f;
            if (speed > 70f) return;                                                 // a GPS jump (over 155 mph): skip this fix
            if (d < noise) return;                                                   // jitter while parked: keep the old anchor
            SharedPreferences p = prefs();
            p.edit().putFloat("meters", p.getFloat("meters", 0f) + d).putLong("moving_ms", p.getLong("moving_ms", 0) + (speed > 2f && dt < 120_000 ? dt : 0)).apply();
        }
        last = l;
    }
    @Override public void onStatusChanged(String p, int s, Bundle b) { }
    @Override public void onProviderEnabled(String p) { }
    @Override public void onProviderDisabled(String p) { }

    /** The freshest position the phone has: {lat, lon, acc, age_s} or {} (for parking, SOS and sharing your location). */
    public String lastLocation() {
        Location best = lastGood;
        LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        if (lm != null && hasPermission()) {
            try {
                for (String prov : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER}) {
                    Location l = lm.getLastKnownLocation(prov);
                    if (l != null && (best == null || l.getTime() > best.getTime() + 30_000 || (Math.abs(l.getTime() - best.getTime()) <= 30_000 && l.getAccuracy() < best.getAccuracy()))) best = l;
                }
            } catch (SecurityException ignored) { }
        }
        JSONObject o = new JSONObject();
        if (best != null) try {
            o.put("lat", best.getLatitude()); o.put("lon", best.getLongitude()); o.put("acc", Math.round(best.getAccuracy()));
            o.put("age_s", Math.max(0, (System.currentTimeMillis() - best.getTime()) / 1000));
        } catch (Exception ignored) { }
        return o.toString();
    }

    /** Asks for one fresh fix (up to timeoutMs) when the last one is old; then returns lastLocation(). Blocks: call off the main thread. */
    public String freshLocation(long timeoutMs) {
        try {
            JSONObject cur = new JSONObject(lastLocation());
            if (cur.has("lat") && cur.optLong("age_s", 9999) < 60 && cur.optInt("acc", 9999) < 100) return cur.toString();
            if (!hasPermission()) return cur.toString();
            final LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
            final java.util.concurrent.CountDownLatch got = new java.util.concurrent.CountDownLatch(1);
            final LocationListener once = new LocationListener() {
                @Override public void onLocationChanged(Location l) { if (l != null && (!l.hasAccuracy() || l.getAccuracy() < 150)) { synchronized (ShiftTracker.this) { lastGood = l; } got.countDown(); } }
                @Override public void onStatusChanged(String p, int s, Bundle b) { }
                @Override public void onProviderEnabled(String p) { }
                @Override public void onProviderDisabled(String p) { }
            };
            for (String prov : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER})
                if (lm.isProviderEnabled(prov)) lm.requestLocationUpdates(prov, 0, 0f, once, Looper.getMainLooper());
            got.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS);
            lm.removeUpdates(once);
        } catch (Exception e) { Log.w(TAG, "fresh", e); }
        return lastLocation();
    }
}
