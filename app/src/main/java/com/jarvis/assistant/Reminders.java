package com.jarvis.assistant;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Reminders and timers that ring even when Jarvis is closed or the phone restarted: each one is an Android alarm
 * (AlarmManager) that posts a notification with sound, and Jarvis says it out loud when he's running.
 * Stored as JSON in SharedPreferences: [{id, at, kind: "reminder"|"timer", text, repeat: ""|"daily"|"weekdays"|"weekly"}].
 */
public final class Reminders {
    private static final String TAG = "JarvisReminders";
    static final String PREFS = "jarvis_reminders", CHANNEL = "jarvis_reminders";
    static final String ACTION_FIRE = "com.jarvis.assistant.REMINDER", ACTION_SNOOZE = "com.jarvis.assistant.SNOOZE", ACTION_DONE = "com.jarvis.assistant.DONE";

    /** Jarvis's page, while it's alive: says the reminder out loud. */
    public interface Listener { void onFire(JSONObject item); }
    public static volatile Listener listener;

    private Reminders() { }

    // ------------------------------------------------------------------ storage
    static synchronized JSONArray all(Context c) {
        try { return new JSONArray(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("items", "[]")); }
        catch (Exception e) { return new JSONArray(); }
    }
    private static synchronized void save(Context c, JSONArray a) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("items", a.toString()).apply();
    }
    static synchronized JSONObject find(Context c, String id) {
        JSONArray a = all(c);
        for (int i = 0; i < a.length(); i++) { JSONObject o = a.optJSONObject(i); if (o != null && id.equals(o.optString("id"))) return o; }
        return null;
    }
    private static synchronized void remove(Context c, String id) {
        JSONArray a = all(c), out = new JSONArray();
        for (int i = 0; i < a.length(); i++) { JSONObject o = a.optJSONObject(i); if (o != null && !id.equals(o.optString("id"))) out.put(o); }
        save(c, out);
    }
    private static synchronized void put(Context c, JSONObject item) {
        remove(c, item.optString("id"));
        JSONArray a = all(c); a.put(item); save(c, a);
    }

    // ------------------------------------------------------------------ scheduling
    /** Adds (or replaces) a reminder and schedules it. Returns "exact" or "inexact" (Android may deliver it a few minutes late). */
    public static String add(Context c, JSONObject item) {
        put(c, item);
        return schedule(c, item);
    }

    public static boolean cancel(Context c, String id) {
        boolean had = find(c, id) != null;
        try { alarms(c).cancel(fireIntent(c, id)); } catch (Exception ignored) { }
        remove(c, id);
        try { ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(notifId(id)); } catch (Exception ignored) { }
        return had;
    }

    /** After a reboot, an app update or a clock change: put every pending alarm back. Anything missed while off rings now. */
    public static void rescheduleAll(Context c) {
        JSONArray a = all(c);
        long now = System.currentTimeMillis();
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o == null) continue;
            if (o.optLong("at") < now - 6 * 3600_000L && o.optString("repeat").isEmpty()) { remove(c, o.optString("id")); continue; }   // long gone
            schedule(c, o);
        }
    }

    static boolean exactAllowed(Context c) {
        try { return Build.VERSION.SDK_INT < 31 || alarms(c).canScheduleExactAlarms(); } catch (Exception e) { return false; }
    }

    private static AlarmManager alarms(Context c) { return (AlarmManager) c.getSystemService(Context.ALARM_SERVICE); }

    private static PendingIntent fireIntent(Context c, String id) {
        Intent i = new Intent(c, AlarmReceiver.class).setAction(ACTION_FIRE).putExtra("id", id);
        return PendingIntent.getBroadcast(c, notifId(id), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static String schedule(Context c, JSONObject item) {
        long at = Math.max(item.optLong("at"), System.currentTimeMillis() + 1000);
        PendingIntent pi = fireIntent(c, item.optString("id"));
        AlarmManager am = alarms(c);
        try {
            if (exactAllowed(c)) {
                // An alarm clock: exact, rings through Doze, and shows the alarm icon. Tapping the icon opens Jarvis.
                PendingIntent show = PendingIntent.getActivity(c, 1, new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE);
                am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), pi);
                return "exact";
            }
        } catch (SecurityException e) { Log.w(TAG, "exact alarm refused", e); }
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        return "inexact";
    }

    static int notifId(String id) { return 5000 + (id.hashCode() & 0x3fffffff) % 100000; }

    /** The next time a repeating reminder rings, after `from`. */
    static long nextRepeat(long at, String repeat, long from) {
        Calendar k = Calendar.getInstance();
        k.setTimeInMillis(at);
        int guard = 0;
        do {
            if ("weekly".equals(repeat)) k.add(Calendar.DAY_OF_YEAR, 7);
            else k.add(Calendar.DAY_OF_YEAR, 1);
            if ("weekdays".equals(repeat)) {
                while (k.get(Calendar.DAY_OF_WEEK) == Calendar.SATURDAY || k.get(Calendar.DAY_OF_WEEK) == Calendar.SUNDAY) k.add(Calendar.DAY_OF_YEAR, 1);
            }
        } while (k.getTimeInMillis() <= from && ++guard < 400);
        return k.getTimeInMillis();
    }

    // ------------------------------------------------------------------ ringing
    /** Called by AlarmReceiver when one is due. */
    static void fire(Context c, String id) {
        JSONObject item = find(c, id);
        if (item == null) return;
        String repeat = item.optString("repeat");
        if (!repeat.isEmpty()) {
            try { JSONObject next = new JSONObject(item.toString()); next.put("at", nextRepeat(item.optLong("at"), repeat, System.currentTimeMillis())); add(c, next); }
            catch (Exception e) { Log.w(TAG, "repeat", e); }
        } else remove(c, id);
        notifyNow(c, item);
        Listener l = listener;
        if (l != null) try { l.onFire(item); } catch (Exception e) { Log.w(TAG, "listener", e); }
    }

    static void snooze(Context c, String id, String text, String kind, int minutes) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", "s" + System.currentTimeMillis()); o.put("at", System.currentTimeMillis() + minutes * 60_000L);
            o.put("kind", kind == null || kind.isEmpty() ? "reminder" : kind); o.put("text", text == null ? "" : text); o.put("repeat", "");
            add(c, o);
        } catch (Exception e) { Log.w(TAG, "snooze", e); }
        try { ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(notifId(id)); } catch (Exception ignored) { }
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Reminders and timers", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Your reminders and timers from Jarvis");
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[]{0, 400, 200, 400});
        ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        nm.createNotificationChannel(ch);
    }

    private static void notifyNow(Context c, JSONObject item) {
        try {
            ensureChannel(c);
            String id = item.optString("id"), kind = item.optString("kind", "reminder"), text = item.optString("text");
            boolean timer = "timer".equals(kind);
            String title = timer ? "Timer done" : "Reminder";
            String body = text.isEmpty() ? (timer ? "Your timer is up." : "You asked me to remind you.") : (timer && !"timer".equalsIgnoreCase(text) ? text + " timer is up." : text);
            PendingIntent open = PendingIntent.getActivity(c, notifId(id), new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
            Intent sn = new Intent(c, AlarmReceiver.class).setAction(ACTION_SNOOZE).putExtra("id", id).putExtra("text", text).putExtra("kind", kind);
            PendingIntent snooze = PendingIntent.getBroadcast(c, notifId(id) + 1, sn, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Intent dn = new Intent(c, AlarmReceiver.class).setAction(ACTION_DONE).putExtra("id", id);
            PendingIntent done = PendingIntent.getBroadcast(c, notifId(id) + 2, dn, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = (Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c))
                    .setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(body)
                    .setStyle(new Notification.BigTextStyle().bigText(body))
                    .setCategory(timer ? Notification.CATEGORY_ALARM : Notification.CATEGORY_REMINDER)
                    .setPriority(Notification.PRIORITY_HIGH).setAutoCancel(true).setContentIntent(open)
                    .addAction(new Notification.Action.Builder(null, "Snooze 10 min", snooze).build())
                    .addAction(new Notification.Action.Builder(null, "Done", done).build());
            ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).notify(notifId(id), b.build());
        } catch (Exception e) { Log.w(TAG, "notify", e); }
    }
}
