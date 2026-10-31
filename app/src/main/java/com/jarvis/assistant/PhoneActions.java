package com.jarvis.assistant;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.AlarmClock;
import android.provider.CalendarContract;
import android.provider.ContactsContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Everyday phone abilities for Jarvis, reached from the page as window.AndroidPhone: reminders, alarms, flashlight,
 * volume, Do Not Disturb, settings pages, contacts and calls, calendar, clipboard, documents, photos, notifications,
 * and phone control. Every method returns a short string (or JSON) the page turns into what Jarvis says.
 */
public class PhoneActions {
    private static final String TAG = "JarvisPhone";
    private static final int REQ = 77;
    private final Activity a;
    private volatile boolean visible = true;
    private boolean torchOn = false;

    public PhoneActions(Activity a) {
        this.a = a;
        Reminders.ensureChannel(a);
        try { Reminders.rescheduleAll(a); } catch (Exception e) { Log.w(TAG, "reschedule", e); }
        try { ShiftTracker.get(a).resume(); } catch (Exception e) { Log.w(TAG, "shift resume", e); }
    }
    void setVisible(boolean v) { visible = v; }

    // ================================================================== opening things, even from the background
    /** Android only lets an app open another app while it's on screen, or with "display over other apps" or an accessibility service on. */
    boolean canOpenNow() {
        return visible || Settings.canDrawOverlays(a) || PhoneControlService.instance != null;
    }

    /** Opens it now when allowed; otherwise posts a "tap to open" notification. Returns "ok", "notified" or "failed". */
    String start(final Intent i, final String what) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (canOpenNow()) {
            a.runOnUiThread(new Runnable() { @Override public void run() {
                try { a.startActivity(i); } catch (Exception e) { Log.w(TAG, "start " + i, e); }
            } });
            return "ok";
        }
        try {
            NotificationManager nm = (NotificationManager) a.getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel("jarvis_actions") == null)
                nm.createNotificationChannel(new NotificationChannel("jarvis_actions", "Things Jarvis opens for you", NotificationManager.IMPORTANCE_HIGH));
            int id = 7000 + (int) (System.currentTimeMillis() % 1000);
            PendingIntent pi = PendingIntent.getActivity(a, id, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = (Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(a, "jarvis_actions") : new Notification.Builder(a))
                    .setSmallIcon(R.drawable.ic_stat).setContentTitle("Tap to open " + what).setContentText("Jarvis can't open apps by himself while he's in the background.")
                    .setAutoCancel(true).setContentIntent(pi).setPriority(Notification.PRIORITY_HIGH).build();
            nm.notify(id, n);
            return "notified";
        } catch (Exception e) { Log.w(TAG, "notify open", e); return "failed"; }
    }

    // ================================================================== permissions
    private boolean has(String p) { return a.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }

    static List<String> basics() {
        List<String> l = new ArrayList<>();
        l.add(Manifest.permission.RECORD_AUDIO); l.add(Manifest.permission.ACCESS_FINE_LOCATION); l.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        if (Build.VERSION.SDK_INT >= 33) l.add(Manifest.permission.POST_NOTIFICATIONS);
        l.add(Manifest.permission.CAMERA); l.add(Manifest.permission.READ_CONTACTS); l.add(Manifest.permission.CALL_PHONE); l.add(Manifest.permission.SEND_SMS);
        l.add(Manifest.permission.READ_CALENDAR); l.add(Manifest.permission.WRITE_CALENDAR);
        return l;
    }
    private static String permFor(String name) {
        switch (name) {
            case "camera": return Manifest.permission.CAMERA;
            case "contacts": return Manifest.permission.READ_CONTACTS;
            case "calls": return Manifest.permission.CALL_PHONE;
            case "calendar": return Manifest.permission.READ_CALENDAR;
            case "notifications": return Build.VERSION.SDK_INT >= 33 ? Manifest.permission.POST_NOTIFICATIONS : null;
            case "sms": return Manifest.permission.SEND_SMS;
            case "location": return Manifest.permission.ACCESS_FINE_LOCATION;
            case "mic": return Manifest.permission.RECORD_AUDIO;
            default: return null;
        }
    }

    @JavascriptInterface
    public String status() {
        JSONObject o = new JSONObject();
        try {
            NotificationManager nm = (NotificationManager) a.getSystemService(Context.NOTIFICATION_SERVICE);
            o.put("notifications", Build.VERSION.SDK_INT < 33 || has(Manifest.permission.POST_NOTIFICATIONS));
            o.put("exactAlarms", Reminders.exactAllowed(a));
            o.put("overlay", Settings.canDrawOverlays(a));
            o.put("control", PhoneControlService.isEnabled(a));
            o.put("controlRunning", PhoneControlService.instance != null);
            o.put("notifAccess", NotifListener.isEnabled(a));
            o.put("camera", has(Manifest.permission.CAMERA));
            o.put("contacts", has(Manifest.permission.READ_CONTACTS));
            o.put("calls", has(Manifest.permission.CALL_PHONE));
            o.put("calendar", has(Manifest.permission.READ_CALENDAR) && has(Manifest.permission.WRITE_CALENDAR));
            o.put("dnd", nm.isNotificationPolicyAccessGranted());
            o.put("brightness", Settings.System.canWrite(a));
            o.put("screenshots", Build.VERSION.SDK_INT >= 30);
            o.put("sms", has(Manifest.permission.SEND_SMS));
            o.put("location", has(Manifest.permission.ACCESS_FINE_LOCATION) || has(Manifest.permission.ACCESS_COARSE_LOCATION));
            o.put("mic", has(Manifest.permission.RECORD_AUDIO));
            o.put("offer", OfferReaderService.isEnabled(a));
            o.put("restricted", restricted(a));
            o.put("assistant", isAssistant(a));
        } catch (Exception e) { Log.w(TAG, "status", e); }
        return o.toString();
    }

    /** Asks for a permission (Android's dialog), or opens the settings page for the special ones. Returns "granted", "asked" or "opened". */
    @JavascriptInterface
    public String request(String name) {
        final String n = name == null ? "" : name;
        if (n.equals("basics")) {                                  // first run: every ordinary permission in one go (Android shows them one after another)
            final List<String> ps = new ArrayList<>();
            for (String x : basics()) if (!has(x)) ps.add(x);
            if (ps.isEmpty()) return "granted";
            a.runOnUiThread(new Runnable() { @Override public void run() { a.requestPermissions(ps.toArray(new String[0]), REQ); } });
            return "asked";
        }
        String p = permFor(n);
        if (p != null || n.equals("calendar")) {
            final List<String> ps = new ArrayList<>();
            if (n.equals("calendar")) { ps.add(Manifest.permission.READ_CALENDAR); ps.add(Manifest.permission.WRITE_CALENDAR); } else ps.add(p);
            // Android 12+ silently ignores a request for precise location on its own: it must come with approximate
            if (Manifest.permission.ACCESS_FINE_LOCATION.equals(p)) ps.add(Manifest.permission.ACCESS_COARSE_LOCATION);
            boolean all = true;
            for (String x : ps) all &= has(x);
            if (all || (n.equals("location") && has(Manifest.permission.ACCESS_COARSE_LOCATION))) return "granted";
            if (!visible) { start(new Intent(a, MainActivity.class), "Jarvis to allow it"); return "asked"; }
            // asked before and refused: Android won't show its window again, so open Jarvis's App info > Permissions instead
            android.content.SharedPreferences asked = a.getSharedPreferences("perm_asks", android.content.Context.MODE_PRIVATE);
            boolean blocked = false;
            for (String x : ps) if (!has(x) && asked.getBoolean(x, false) && !a.shouldShowRequestPermissionRationale(x)) blocked = true;
            if (blocked) { a.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + a.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return "settings"; }
            android.content.SharedPreferences.Editor ed = asked.edit(); for (String x : ps) ed.putBoolean(x, true); ed.apply();
            a.runOnUiThread(new Runnable() { @Override public void run() { a.requestPermissions(ps.toArray(new String[0]), REQ); } });
            return "asked";
        }
        Intent i;
        Uri me = Uri.parse("package:" + a.getPackageName());
        switch (n) {
            case "exactAlarms": i = Build.VERSION.SDK_INT >= 31 ? new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, me) : null; break;
            case "overlay": i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, me); break;
            case "control": return openAccessibility(PhoneControlService.class);
            case "offer": return openAccessibility(OfferReaderService.class);
            case "notifAccess": {
                ComponentName me2 = new ComponentName(a, NotifListener.class);
                Intent fb = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).putExtra(":settings:fragment_args_key", me2.flattenToString());
                if (Build.VERSION.SDK_INT >= 30) return startFirst(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, me2.flattenToString()), fb);
                i = fb; break;
            }
            case "appInfo": i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, me); break;
            case "dnd": i = new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS); break;
            case "brightness": i = new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, me); break;
            case "assistant": return startFirst(new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS), new Intent(Settings.ACTION_VOICE_INPUT_SETTINGS));   // "Digital assistant app"
            default: return "unknown";
        }
        if (i == null) return "granted";
        start(i, "settings");
        return "opened";
    }

    /** Is Jarvis the phone's digital assistant (long-press the side button / home, or swipe up from a bottom corner)? */
    static boolean isAssistant(Context c) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                android.app.role.RoleManager rm = (android.app.role.RoleManager) c.getSystemService(Context.ROLE_SERVICE);
                return rm != null && rm.isRoleAvailable(android.app.role.RoleManager.ROLE_ASSISTANT) && rm.isRoleHeld(android.app.role.RoleManager.ROLE_ASSISTANT);
            }
            String cur = Settings.Secure.getString(c.getContentResolver(), "assistant");
            return cur != null && cur.startsWith(c.getPackageName() + "/");
        } catch (Exception e) { return false; }
    }

    /** Opens the page for one of Jarvis's accessibility switches directly (not the long list where it's hard to find). */
    String openAccessibility(Class<?> svc) {
        String cn = new ComponentName(a, svc).flattenToString();
        Bundle args = new Bundle(); args.putString(":settings:fragment_args_key", cn);
        Intent list = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).putExtra(":settings:fragment_args_key", cn).putExtra(":settings:show_fragment_args", args);
        if (Build.VERSION.SDK_INT >= 30) return startFirst(new Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS").putExtra(Intent.EXTRA_COMPONENT_NAME, cn), list);
        start(list, "settings"); return "opened";
    }
    /** Tries the exact page first; if this phone doesn't have it, the general one. */
    String startFirst(final Intent first, final Intent fallback) {
        first.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (!canOpenNow()) { start(first.resolveActivity(a.getPackageManager()) != null ? first : fallback, "settings"); return "opened"; }
        a.runOnUiThread(new Runnable() { @Override public void run() {
            try { a.startActivity(first); } catch (Exception e) { Log.w(TAG, "exact page missing, using the list", e); try { a.startActivity(fallback); } catch (Exception e2) { Log.w(TAG, "settings", e2); } }
        } });
        return "opened";
    }
    /** Android 13+ blocks accessibility and notification access for apps installed from a file until the user allows
     *  "restricted settings" in Jarvis's App info. True while that block is on (best effort; false if unknown). */
    static boolean restricted(Context c) {
        if (Build.VERSION.SDK_INT < 33) return false;
        try {
            android.app.AppOpsManager ops = (android.app.AppOpsManager) c.getSystemService(Context.APP_OPS_SERVICE);
            int mode = ops.unsafeCheckOpNoThrow("android:access_restricted_settings", c.getApplicationInfo().uid, c.getPackageName());
            return mode == android.app.AppOpsManager.MODE_ERRORED || mode == android.app.AppOpsManager.MODE_IGNORED;
        } catch (Exception e) { return false; }
    }

    // ================================================================== reminders, timers, alarms
    /** item: {id, at (epoch ms), kind, text, repeat}. Returns "exact" / "inexact". */
    @JavascriptInterface public String reminderAdd(String json) {
        try { return Reminders.add(a, new JSONObject(json)); } catch (Exception e) { Log.w(TAG, "reminderAdd", e); return "error"; }
    }
    @JavascriptInterface public boolean reminderCancel(String id) { return Reminders.cancel(a, id); }
    @JavascriptInterface public String reminderList() { return Reminders.all(a).toString(); }

    /** A wake-up alarm in the phone's Clock app. days: "" or e.g. "mon,tue,wed,thu,fri". */
    @JavascriptInterface
    public String clockAlarm(int hour, int minute, String label, String days) {
        Intent i = new Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, hour).putExtra(AlarmClock.EXTRA_MINUTES, minute)
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        if (label != null && !label.isEmpty()) i.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        ArrayList<Integer> d = new ArrayList<>();
        String ds = days == null ? "" : days.toLowerCase(Locale.ROOT);
        String[] names = {"sun", "mon", "tue", "wed", "thu", "fri", "sat"};
        for (int k = 0; k < 7; k++) if (ds.contains(names[k])) d.add(k + 1);   // Calendar.SUNDAY = 1
        if (!d.isEmpty()) i.putExtra(AlarmClock.EXTRA_DAYS, d);
        if (i.resolveActivity(a.getPackageManager()) == null) return "no-clock";
        return start(i, "the Clock app");
    }
    @JavascriptInterface public String showClockAlarms() { return start(new Intent(AlarmClock.ACTION_SHOW_ALARMS), "your alarms"); }

    // ================================================================== device
    private String torchId = null;
    private boolean torchWatching = false;
    /** The real torch state: also changes when the user flips the torch in quick settings. */
    private void watchTorch(CameraManager cm) {
        if (torchWatching) return; torchWatching = true;
        try {
            cm.registerTorchCallback(new CameraManager.TorchCallback() {
                @Override public void onTorchModeChanged(String id, boolean enabled) { if (id.equals(torchId)) torchOn = enabled; }
                @Override public void onTorchModeUnavailable(String id) { }
            }, new android.os.Handler(android.os.Looper.getMainLooper()));
        } catch (Exception e) { Log.w(TAG, "torch callback", e); }
    }
    /** Cameras with a flash, back-facing first. */
    private List<String> torchCandidates(CameraManager cm) throws Exception {
        List<String> back = new ArrayList<>(), other = new ArrayList<>();
        for (String c : cm.getCameraIdList()) {
            CameraCharacteristics ch = cm.getCameraCharacteristics(c);
            Boolean f = ch.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            if (f == null || !f) continue;
            Integer facing = ch.get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) back.add(c); else other.add(c);
        }
        back.addAll(other);
        return back;
    }
    @JavascriptInterface
    public String flashlight(String what) {
        CameraManager cm = (CameraManager) a.getSystemService(Context.CAMERA_SERVICE);
        if (cm == null) return "This phone has no flashlight I can reach.";
        List<String> ids;
        try { ids = torchCandidates(cm); } catch (Exception e) { Log.w(TAG, "torch list", e); return "I couldn't reach the flashlight."; }
        if (ids.isEmpty()) return "This phone has no flashlight I can reach.";
        if (torchId == null || !ids.contains(torchId)) torchId = ids.get(0);
        watchTorch(cm);
        String w = what == null ? "toggle" : what.toLowerCase(Locale.ROOT).trim();
        boolean on = "toggle".equals(w) ? !torchOn : !"off".equals(w);
        Exception last = null;
        if (!on) {                                               // off: every camera with a light, so nothing is left burning
            boolean any = false;
            for (int attempt = 0; attempt < 2 && !any; attempt++) {
                for (String id : ids) { try { cm.setTorchMode(id, false); any = true; } catch (Exception e) { last = e; Log.w(TAG, "torch off " + id, e); } }
                if (!any) try { Thread.sleep(350); } catch (InterruptedException ignored) { }
            }
            if (any) { torchOn = false; return "Flashlight off."; }
        }
        for (int attempt = 0; attempt < 2 && on; attempt++) {
            List<String> order = new ArrayList<>(); order.add(torchId); for (String id : ids) if (!id.equals(torchId)) order.add(id);
            for (String id : order) {
                try { cm.setTorchMode(id, on); torchId = id; torchOn = on; return on ? "Flashlight on." : "Flashlight off."; }
                catch (Exception e) { last = e; Log.w(TAG, "torch " + id, e); }
            }
            try { Thread.sleep(350); } catch (InterruptedException ignored) { }
        }
        if (last instanceof android.hardware.camera2.CameraAccessException) {
            int r = ((android.hardware.camera2.CameraAccessException) last).getReason();
            if (r == android.hardware.camera2.CameraAccessException.CAMERA_DISABLED) return "The flashlight is switched off by this phone's settings or a work profile.";
            if (r == android.hardware.camera2.CameraAccessException.CAMERA_IN_USE || r == android.hardware.camera2.CameraAccessException.MAX_CAMERAS_IN_USE)
                return "The camera is in use by another app, so the flashlight can't come on. Close the camera app and ask again.";
        }
        return "The flashlight didn't respond. Try the torch in your quick settings; if that works, tell me and I'll try again.";
    }

    private static int stream(String s) {
        String x = s == null ? "" : s.toLowerCase(Locale.ROOT);
        if (x.contains("ring")) return AudioManager.STREAM_RING;
        if (x.contains("alarm")) return AudioManager.STREAM_ALARM;
        if (x.contains("call") || x.contains("voice")) return AudioManager.STREAM_VOICE_CALL;
        if (x.contains("notif")) return AudioManager.STREAM_NOTIFICATION;
        return AudioManager.STREAM_MUSIC;
    }

    /** action: up, down, mute, unmute, max, set (level 0-100). */
    @JavascriptInterface
    public String volume(String action, int level, String which) {
        try {
            AudioManager am = (AudioManager) a.getSystemService(Context.AUDIO_SERVICE);
            int s = stream(which), max = am.getStreamMaxVolume(s);
            String act = action == null ? "" : action.toLowerCase(Locale.ROOT);
            switch (act) {
                case "up": am.adjustStreamVolume(s, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI); am.adjustStreamVolume(s, AudioManager.ADJUST_RAISE, 0); break;
                case "down": am.adjustStreamVolume(s, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI); am.adjustStreamVolume(s, AudioManager.ADJUST_LOWER, 0); break;
                case "mute": am.adjustStreamVolume(s, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI); break;
                case "unmute": am.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, AudioManager.FLAG_SHOW_UI); break;
                case "max": am.setStreamVolume(s, max, AudioManager.FLAG_SHOW_UI); break;
                default: am.setStreamVolume(s, Math.round(Math.max(0, Math.min(100, level)) / 100f * max), AudioManager.FLAG_SHOW_UI);
            }
            int now = Math.round(am.getStreamVolume(s) * 100f / Math.max(1, max));
            return "Volume " + now + " percent.";
        } catch (SecurityException e) { return "Android needs Do Not Disturb access before I can silence the ringer."; }
        catch (Exception e) { return "I couldn't change the volume."; }
    }

    /** mode: silent, vibrate, normal. */
    @JavascriptInterface
    public String ringer(String mode) {
        try {
            AudioManager am = (AudioManager) a.getSystemService(Context.AUDIO_SERVICE);
            String m = mode == null ? "" : mode.toLowerCase(Locale.ROOT);
            am.setRingerMode(m.startsWith("sil") ? AudioManager.RINGER_MODE_SILENT : m.startsWith("vib") ? AudioManager.RINGER_MODE_VIBRATE : AudioManager.RINGER_MODE_NORMAL);
            return m.startsWith("sil") ? "Phone on silent." : m.startsWith("vib") ? "Phone on vibrate." : "Ringer back on.";
        } catch (SecurityException e) { return "need-dnd"; }
        catch (Exception e) { return "I couldn't change the ringer."; }
    }

    @JavascriptInterface
    public String dnd(boolean on) {
        NotificationManager nm = (NotificationManager) a.getSystemService(Context.NOTIFICATION_SERVICE);
        if (!nm.isNotificationPolicyAccessGranted()) return "need-dnd";
        nm.setInterruptionFilter(on ? NotificationManager.INTERRUPTION_FILTER_PRIORITY : NotificationManager.INTERRUPTION_FILTER_ALL);
        return on ? "Do Not Disturb on." : "Do Not Disturb off.";
    }

    /** level 0-100, or -1 for automatic. */
    @JavascriptInterface
    public String brightness(int level) {
        if (!Settings.System.canWrite(a)) return "need-brightness";
        ContentResolver r = a.getContentResolver();
        if (level < 0) { Settings.System.putInt(r, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC); return "Brightness on automatic."; }
        Settings.System.putInt(r, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL);
        Settings.System.putInt(r, Settings.System.SCREEN_BRIGHTNESS, Math.max(1, Math.round(Math.min(100, level) * 2.55f)));
        return "Brightness " + Math.min(100, Math.max(0, level)) + " percent.";
    }

    /** Opens a settings page (or the quick panel for Wi-Fi / internet / volume / NFC). Apps can't flip Wi-Fi or Bluetooth themselves any more. */
    @JavascriptInterface
    public String openSettings(String page) {
        String p = page == null ? "" : page.toLowerCase(Locale.ROOT).replaceAll("[^a-z]", "");
        Intent i;
        if (p.contains("wifi") && Build.VERSION.SDK_INT >= 29) i = new Intent(Settings.Panel.ACTION_WIFI);
        else if ((p.contains("internet") || p.contains("data") || p.contains("mobile")) && Build.VERSION.SDK_INT >= 29) i = new Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY);
        else if (p.contains("volume") || p.contains("sound")) i = Build.VERSION.SDK_INT >= 29 ? new Intent(Settings.Panel.ACTION_VOLUME) : new Intent(Settings.ACTION_SOUND_SETTINGS);
        else if (p.contains("nfc")) i = new Intent(Settings.ACTION_NFC_SETTINGS);
        else if (p.contains("bluetooth")) i = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
        else if (p.contains("hotspot") || p.contains("tether")) i = new Intent().setClassName("com.android.settings", "com.android.settings.TetherSettings");
        else if (p.contains("airplane") || p.contains("flight")) i = new Intent(Settings.ACTION_AIRPLANE_MODE_SETTINGS);
        else if (p.contains("location") || p.contains("gps")) i = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        else if (p.contains("battery") || p.contains("power")) i = new Intent(Intent.ACTION_POWER_USAGE_SUMMARY);
        else if (p.contains("display") || p.contains("bright") || p.contains("screen")) i = new Intent(Settings.ACTION_DISPLAY_SETTINGS);
        else if (p.contains("notif")) i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, a.getPackageName());
        else if (p.contains("app")) i = new Intent(Settings.ACTION_APPLICATION_SETTINGS);
        else if (p.contains("storage")) i = new Intent(Settings.ACTION_INTERNAL_STORAGE_SETTINGS);
        else if (p.contains("date") || p.contains("time")) i = new Intent(Settings.ACTION_DATE_SETTINGS);
        else if (p.contains("access")) i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        else if (p.contains("about") || p.contains("phoneinfo")) i = new Intent(Settings.ACTION_DEVICE_INFO_SETTINGS);
        else if (p.contains("security") || p.contains("lock")) i = new Intent(Settings.ACTION_SECURITY_SETTINGS);
        else if (p.contains("language")) i = new Intent(Settings.ACTION_LOCALE_SETTINGS);
        else if (p.contains("jarvis")) i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + a.getPackageName()));
        else i = new Intent(Settings.ACTION_SETTINGS);
        if (i.resolveActivity(a.getPackageManager()) == null) i = new Intent(Settings.ACTION_SETTINGS);
        return start(i, "settings");
    }

    /** mode: photo, video, selfie. Opens the phone's camera app. */
    @JavascriptInterface
    public String openCamera(String mode) {
        String m = mode == null ? "" : mode.toLowerCase(Locale.ROOT);
        Intent i = new Intent(m.contains("video") ? MediaStore.INTENT_ACTION_VIDEO_CAMERA : MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA);
        if (m.contains("selfie") || m.contains("front")) { i.putExtra("android.intent.extras.CAMERA_FACING", 1); i.putExtra("android.intent.extra.USE_FRONT_CAMERA", true); }
        return start(i, "the camera");
    }

    /** Brings Jarvis to the front (for the camera, which only works while he's on screen). */
    @JavascriptInterface public String bringToFront() { return start(new Intent(a, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT), "Jarvis"); }
    @JavascriptInterface public boolean isVisible() { return visible; }

    // ================================================================== contacts, calls, messages
    @JavascriptInterface
    public String findContact(String name) {
        if (!has(Manifest.permission.READ_CONTACTS)) return "need-contacts";
        JSONArray out = new JSONArray();
        Uri u = Uri.withAppendedPath(ContactsContract.CommonDataKinds.Phone.CONTENT_FILTER_URI, Uri.encode(name == null ? "" : name.trim()));
        String[] cols = {ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER, ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.IS_PRIMARY};
        try (Cursor c = a.getContentResolver().query(u, cols, null, null, ContactsContract.CommonDataKinds.Phone.IS_PRIMARY + " DESC")) {
            List<String> seen = new ArrayList<>();
            while (c != null && c.moveToNext() && out.length() < 8) {
                String num = c.getString(1) == null ? "" : c.getString(1).replaceAll("[^\\d+]", "");
                if (num.isEmpty() || seen.contains(c.getString(0) + num)) continue;
                seen.add(c.getString(0) + num);
                JSONObject o = new JSONObject();
                o.put("name", c.getString(0)); o.put("number", num);
                o.put("type", String.valueOf(ContactsContract.CommonDataKinds.Phone.getTypeLabel(a.getResources(), c.getInt(2), "")).toLowerCase(Locale.ROOT));
                out.put(o);
            }
        } catch (Exception e) { Log.w(TAG, "contacts", e); }
        return out.toString();
    }

    /** Calls straight away when Jarvis may place calls; otherwise opens the dialer with the number ready. */
    @JavascriptInterface
    public String call(String number) {
        String n = number == null ? "" : number.replaceAll("[^\\d+*#]", "");
        if (n.isEmpty()) return "no-number";
        boolean direct = has(Manifest.permission.CALL_PHONE);
        String r = start(new Intent(direct ? Intent.ACTION_CALL : Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(n))), "the call");
        return "ok".equals(r) ? (direct ? "calling" : "dialer") : r;
    }

    @JavascriptInterface
    public String sms(String number, String text) {
        String n = number == null ? "" : number.replaceAll("[^\\d+]", "");
        Intent i = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + n)).putExtra("sms_body", text == null ? "" : text);
        return start(i, "your message");
    }

    @JavascriptInterface
    public String whatsapp(String number, String text) {
        String n = number == null ? "" : number.replaceAll("[^\\d]", "");
        Uri u = Uri.parse("https://wa.me/" + n + (text == null || text.isEmpty() ? "" : "?text=" + Uri.encode(text)));
        return start(new Intent(Intent.ACTION_VIEW, u), "WhatsApp");
    }

    // ---- notifications (NotifListener)
    @JavascriptInterface public String notifications(boolean onlyMessages, String app, int max) {
        if (!NotifListener.isEnabled(a)) return "need-notifAccess";
        if (NotifListener.instance == null) return "starting";
        return NotifListener.list(onlyMessages, app, Math.max(1, Math.min(max, 15)));
    }
    @JavascriptInterface public String replyTo(String who, String text) {
        if (!NotifListener.isEnabled(a)) return "need-notifAccess";
        return NotifListener.reply(a, who, text);
    }

    /** Birthdays saved in the phone's contacts: [{name, md: "MM-DD", year: 1990 | 0}]. */
    @JavascriptInterface
    public String birthdays() {
        if (!has(Manifest.permission.READ_CONTACTS)) return "need-contacts";
        JSONArray out = new JSONArray();
        String[] cols = {ContactsContract.CommonDataKinds.Event.DISPLAY_NAME, ContactsContract.CommonDataKinds.Event.START_DATE};
        String where = ContactsContract.Data.MIMETYPE + "=? AND " + ContactsContract.CommonDataKinds.Event.TYPE + "=?";
        String[] args = {ContactsContract.CommonDataKinds.Event.CONTENT_ITEM_TYPE, String.valueOf(ContactsContract.CommonDataKinds.Event.TYPE_BIRTHDAY)};
        try (Cursor c = a.getContentResolver().query(ContactsContract.Data.CONTENT_URI, cols, where, args, null)) {
            while (c != null && c.moveToNext() && out.length() < 2000) {
                String d = c.getString(1) == null ? "" : c.getString(1).trim();      // "1990-04-12", "--04-12", "19900412"
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(\\d{4}|-)-?(\\d{2})-?(\\d{2})").matcher(d);
                if (!m.find()) continue;
                JSONObject o = new JSONObject();
                o.put("name", c.getString(0)); o.put("md", m.group(2) + "-" + m.group(3)); o.put("year", m.group(1).length() == 4 ? Integer.parseInt(m.group(1)) : 0);
                out.put(o);
            }
        } catch (Exception e) { Log.w(TAG, "birthdays", e); }
        return out.toString();
    }

    // ================================================================== calendar
    @JavascriptInterface
    public String calendarEvents(double fromMs, double toMs) {
        if (!has(Manifest.permission.READ_CALENDAR)) return "need-calendar";
        JSONArray out = new JSONArray();
        Uri.Builder b = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(b, (long) fromMs);
        ContentUris.appendId(b, (long) toMs);
        String[] cols = {CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.EVENT_LOCATION};
        try (Cursor c = a.getContentResolver().query(b.build(), cols, CalendarContract.Instances.VISIBLE + "=1", null, CalendarContract.Instances.BEGIN + " ASC")) {
            while (c != null && c.moveToNext() && out.length() < 25) {
                JSONObject o = new JSONObject();
                o.put("title", c.getString(0) == null ? "(no title)" : c.getString(0)); o.put("begin", c.getLong(1)); o.put("end", c.getLong(2));
                o.put("allDay", c.getInt(3) == 1); o.put("location", c.getString(4) == null ? "" : c.getString(4));
                out.put(o);
            }
        } catch (Exception e) { Log.w(TAG, "calendar", e); return "error"; }
        return out.toString();
    }

    @JavascriptInterface
    public String calendarAdd(String title, double startMs, double endMs, String location, boolean allDay) {
        if (!has(Manifest.permission.WRITE_CALENDAR) || !has(Manifest.permission.READ_CALENDAR)) return "need-calendar";
        long calId = -1;
        String calName = "";
        String[] cols = {CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, CalendarContract.Calendars.IS_PRIMARY, CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL};
        try (Cursor c = a.getContentResolver().query(CalendarContract.Calendars.CONTENT_URI, cols, CalendarContract.Calendars.VISIBLE + "=1", null, null)) {
            int best = -1;
            while (c != null && c.moveToNext()) {
                if (c.getInt(3) < CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR) continue;
                int score = c.getInt(2) == 1 ? 2 : 1;
                if (score > best) { best = score; calId = c.getLong(0); calName = c.getString(1); }
            }
        } catch (Exception e) { Log.w(TAG, "calendars", e); }
        if (calId < 0) return "no-calendar";
        try {
            ContentValues v = new ContentValues();
            v.put(CalendarContract.Events.CALENDAR_ID, calId);
            v.put(CalendarContract.Events.TITLE, title);
            v.put(CalendarContract.Events.DTSTART, (long) startMs);
            v.put(CalendarContract.Events.DTEND, (long) Math.max(endMs, startMs + 60_000));
            v.put(CalendarContract.Events.EVENT_TIMEZONE, allDay ? "UTC" : TimeZone.getDefault().getID());
            if (allDay) v.put(CalendarContract.Events.ALL_DAY, 1);
            if (location != null && !location.isEmpty()) v.put(CalendarContract.Events.EVENT_LOCATION, location);
            Uri u = a.getContentResolver().insert(CalendarContract.Events.CONTENT_URI, v);
            return u == null ? "error" : "ok:" + calName;
        } catch (Exception e) { Log.w(TAG, "calendarAdd", e); return "error"; }
    }

    // ================================================================== clipboard
    @JavascriptInterface
    public String clipboardGet() {
        final String[] out = {""};
        final java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        a.runOnUiThread(new Runnable() { @Override public void run() {
            try {
                ClipboardManager cm = (ClipboardManager) a.getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData d = cm.getPrimaryClip();
                if (d != null && d.getItemCount() > 0) { CharSequence t = d.getItemAt(0).coerceToText(a); out[0] = t == null ? "" : t.toString(); }
            } catch (Exception e) { Log.w(TAG, "clip", e); }
            done.countDown();
        } });
        try { done.await(2, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        return out[0];
    }

    @JavascriptInterface
    public String clipboardSet(final String text) {
        a.runOnUiThread(new Runnable() { @Override public void run() {
            try { ((ClipboardManager) a.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Jarvis", text)); } catch (Exception e) { Log.w(TAG, "clipSet", e); }
        } });
        return "ok";
    }

    // ================================================================== documents (Documents/Jarvis) and photos (Pictures/Jarvis)
    private static String safeName(String s) {
        String n = (s == null ? "" : s).replaceAll("[\\\\/:*?\"<>|\\n\\r\\t]+", " ").replaceAll("\\s+", " ").trim();
        if (n.length() > 60) n = n.substring(0, 60).trim();
        return n.isEmpty() ? "Jarvis document" : n;
    }

    private Uri saveFile(String folder, String name, String mime, byte[] data) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/Jarvis");
            Uri base = folder.equals(Environment.DIRECTORY_PICTURES) ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI : MediaStore.Files.getContentUri("external");
            Uri u = a.getContentResolver().insert(base, v);
            if (u == null) throw new IllegalStateException("insert failed");
            try (OutputStream os = a.getContentResolver().openOutputStream(u)) { os.write(data); }
            return u;
        }
        File dir = new File(a.getExternalFilesDir(folder), "Jarvis");
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("no folder");
        File f = new File(dir, name);
        try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(data); }
        return Uri.fromFile(f);
    }

    private static byte[] pdf(String title, String body) throws Exception {
        PdfDocument doc = new PdfDocument();
        int w = 595, h = 842, m = 56;                                  // A4 in points
        TextPaint tp = new TextPaint(Paint.ANTI_ALIAS_FLAG); tp.setTextSize(11.5f); tp.setColor(0xFF222222);
        TextPaint hp = new TextPaint(Paint.ANTI_ALIAS_FLAG); hp.setTextSize(20f); hp.setTypeface(Typeface.DEFAULT_BOLD); hp.setColor(0xFF111111);
        StaticLayout head = StaticLayout.Builder.obtain(title, 0, title.length(), hp, w - 2 * m).build();
        StaticLayout all = StaticLayout.Builder.obtain(body, 0, body.length(), tp, w - 2 * m).setLineSpacing(3f, 1f).setAlignment(Layout.Alignment.ALIGN_NORMAL).build();
        int line = 0, page = 1;
        while (line < all.getLineCount() || page == 1) {
            PdfDocument.Page p = doc.startPage(new PdfDocument.PageInfo.Builder(w, h, page).create());
            Canvas c = p.getCanvas();
            int top = m;
            if (page == 1) { c.save(); c.translate(m, m); head.draw(c); c.restore(); top += head.getHeight() + 18; }
            int startY = all.getLineTop(Math.min(line, Math.max(0, all.getLineCount() - 1))), room = h - m - top, end = line;
            while (end < all.getLineCount() && all.getLineBottom(end) - startY <= room) end++;
            if (end == line && line < all.getLineCount()) end = line + 1;
            c.save();
            c.translate(m, top - startY);
            c.clipRect(0, startY, w - 2 * m, all.getLineCount() == 0 ? startY : all.getLineBottom(Math.max(line, end - 1)));
            all.draw(c);
            c.restore();
            doc.finishPage(p);
            line = end; page++;
            if (all.getLineCount() == 0) break;
        }
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        doc.writeTo(bo);
        doc.close();
        return bo.toByteArray();
    }

    private static String xml(String s) { return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;"); }

    private static byte[] docx(String title, String body) throws Exception {
        StringBuilder d = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>");
        d.append("<w:p><w:pPr><w:spacing w:after=\"240\"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val=\"36\"/></w:rPr><w:t xml:space=\"preserve\">").append(xml(title)).append("</w:t></w:r></w:p>");
        for (String para : body.split("\\r?\\n")) d.append("<w:p><w:r><w:t xml:space=\"preserve\">").append(xml(para)).append("</w:t></w:r></w:p>");
        d.append("<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1134\" w:right=\"1134\" w:bottom=\"1134\" w:left=\"1134\"/></w:sectPr></w:body></w:document>");
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(bo)) {
            put(z, "[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>");
            put(z, "_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>");
            put(z, "word/document.xml", d.toString());
        }
        return bo.toByteArray();
    }

    private static void put(ZipOutputStream z, String name, String content) throws Exception {
        z.putNextEntry(new ZipEntry(name));
        z.write(content.getBytes(StandardCharsets.UTF_8));
        z.closeEntry();
    }

    /** kind: pdf, docx, txt. Saves to Documents/Jarvis and returns {"name":..,"uri":..} or an error string. */
    @JavascriptInterface
    public String docSave(String kind, String title, String content) {
        try {
            String k = kind == null ? "txt" : kind.toLowerCase(Locale.ROOT).replace("word", "docx").replace(".", "");
            String t = title == null || title.trim().isEmpty() ? "Jarvis document" : title.trim(), body = content == null ? "" : content;
            String stamp = new SimpleDateFormat("yyyy-MM-dd HHmm", Locale.US).format(new Date());
            byte[] data; String mime, ext;
            if (k.startsWith("pdf")) { data = pdf(t, body); mime = "application/pdf"; ext = ".pdf"; }
            else if (k.startsWith("doc")) { data = docx(t, body); mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; ext = ".docx"; }
            else if (k.startsWith("csv")) { data = body.getBytes(StandardCharsets.UTF_8); mime = "text/csv"; ext = ".csv"; }
            else { data = (t + "\n\n" + body).getBytes(StandardCharsets.UTF_8); mime = "text/plain"; ext = ".txt"; }
            String name = safeName(t) + " " + stamp + ext;
            Uri u = saveFile(Environment.DIRECTORY_DOCUMENTS, name, mime, data);
            JSONObject o = new JSONObject(); o.put("name", name); o.put("uri", u.toString()); o.put("mime", mime);
            return o.toString();
        } catch (Exception e) { Log.w(TAG, "docSave", e); return "error: " + e.getMessage(); }
    }

    /** Jarvis's documents, newest first: [{name, uri, mime, size, date}]. */
    @JavascriptInterface
    public String docList() {
        JSONArray out = new JSONArray();
        if (Build.VERSION.SDK_INT < 29) {
            File dir = new File(a.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS), "Jarvis");
            File[] fs = dir.listFiles();
            if (fs != null) for (File f : fs) try { JSONObject o = new JSONObject(); o.put("name", f.getName()); o.put("uri", Uri.fromFile(f).toString()); o.put("size", f.length()); o.put("date", f.lastModified()); out.put(o); } catch (Exception ignored) { }
            return out.toString();
        }
        Uri base = MediaStore.Files.getContentUri("external");
        String[] cols = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED};
        try (Cursor c = a.getContentResolver().query(base, cols, MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?", new String[]{Environment.DIRECTORY_DOCUMENTS + "/Jarvis%"}, MediaStore.MediaColumns.DATE_MODIFIED + " DESC")) {
            while (c != null && c.moveToNext() && out.length() < 40) {
                JSONObject o = new JSONObject();
                o.put("name", c.getString(1)); o.put("uri", ContentUris.withAppendedId(base, c.getLong(0)).toString());
                o.put("mime", c.getString(2)); o.put("size", c.getLong(3)); o.put("date", c.getLong(4) * 1000);
                out.put(o);
            }
        } catch (Exception e) { Log.w(TAG, "docList", e); }
        return out.toString();
    }

    @JavascriptInterface
    public String docOpen(String uri, String mime, boolean share) {
        try {
            Uri u = Uri.parse(uri);
            Intent i;
            if (share) i = Intent.createChooser(new Intent(Intent.ACTION_SEND).setType(mime == null || mime.isEmpty() ? "*/*" : mime).putExtra(Intent.EXTRA_STREAM, u).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Share");
            else i = new Intent(Intent.ACTION_VIEW).setDataAndType(u, mime == null || mime.isEmpty() ? "*/*" : mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return start(i, share ? "the share menu" : "your document");
        } catch (Exception e) { return "failed"; }
    }

    @JavascriptInterface
    public boolean docDelete(String uri) {
        try { return a.getContentResolver().delete(Uri.parse(uri), null, null) > 0; } catch (Exception e) { Log.w(TAG, "docDelete", e); return false; }
    }

    /** Saves a JPEG (base64) from Jarvis's camera to Pictures/Jarvis. Returns the file name. */
    @JavascriptInterface
    public String photoSave(String b64) {
        try {
            byte[] data = java.util.Base64.getDecoder().decode(b64.replaceFirst("^data:[^,]*,", ""));
            String name = "Jarvis " + new SimpleDateFormat("yyyy-MM-dd HHmmss", Locale.US).format(new Date()) + ".jpg";
            saveFile(Environment.DIRECTORY_PICTURES, name, "image/jpeg", data);
            return name;
        } catch (Exception e) { Log.w(TAG, "photoSave", e); return ""; }
    }

    // ================================================================== driving: shifts, mileage, location (ShiftTracker)
    @JavascriptInterface public String shiftStart() { return ShiftTracker.get(a).start(); }
    @JavascriptInterface public String shiftEnd() { return ShiftTracker.get(a).end(); }
    @JavascriptInterface public String shiftStatus() { return ShiftTracker.get(a).status(); }
    @JavascriptInterface public String trips() { return ShiftTracker.get(a).trips().toString(); }
    @JavascriptInterface public String lastLocation() { return ShiftTracker.get(a).lastLocation(); }
    /** Waits up to timeoutMs for a fresh GPS fix when the last one is stale. */
    @JavascriptInterface public String freshLocation(int timeoutMs) { return ShiftTracker.get(a).freshLocation(Math.max(1000, Math.min(timeoutMs, 15000))); }

    // ================================================================== safety (SosManager)
    @JavascriptInterface public String sosStart(String contactsJson, String name, String message) { return SosManager.get(a).start(contactsJson, name, message); }
    @JavascriptInterface public String sosStop(String message) { return SosManager.get(a).stop(message); }
    @JavascriptInterface public boolean sosActive() { return SosManager.get(a).active(); }
    @JavascriptInterface public int shareLocation(String numbersJson, String text) { return SosManager.get(a).shareLocation(numbersJson, text); }
    @JavascriptInterface public String placeText() { return SosManager.get(a).placeText(); }
    /** Opens the phone dialer with an emergency number ready (Android lets only the user place emergency calls). */
    @JavascriptInterface public String dialEmergency(String number) {
        String n = number == null || number.replaceAll("[^\\d]", "").isEmpty() ? "911" : number.replaceAll("[^\\d]", "");
        return start(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + n)), "the dialer");
    }

    // ================================================================== faces (FaceEngine): "remember my face", "who is this?"
    private FaceEngine faces;
    private synchronized FaceEngine faces() { if (faces == null) faces = new FaceEngine(a); return faces; }
    private static byte[] jpeg(String b64) { return java.util.Base64.getDecoder().decode(b64.replaceFirst("^data:[^,]*,", "")); }

    /** {"ok":true,"samples":n} / {"ok":false,"error":"noface"|"unavailable"|...} */
    @JavascriptInterface
    public String faceRemember(String b64, String name, String title) {
        JSONObject o = new JSONObject();
        try {
            if (!faces().available()) return o.put("ok", false).put("error", "unavailable").toString();
            float[] sig = faces().signature(jpeg(b64));
            if (sig == null) return o.put("ok", false).put("error", "noface").toString();
            return o.put("ok", true).put("samples", faces().remember(name, title, sig)).toString();
        } catch (Exception e) { Log.w(TAG, "faceRemember", e); try { return o.put("ok", false).put("error", String.valueOf(e.getMessage())).toString(); } catch (Exception x) { return "{}"; } }
    }

    /** {"ok":true,"face":true,"match":{name,title,similarity}|null} or {"ok":false,"error":..} */
    @JavascriptInterface
    public String faceIdentify(String b64) {
        JSONObject o = new JSONObject();
        try {
            if (!faces().available()) return o.put("ok", false).put("error", "unavailable").toString();
            float[] sig = faces().signature(jpeg(b64));
            o.put("ok", true).put("face", sig != null);
            if (sig != null) { JSONObject m = faces().match(sig); o.put("match", m == null ? JSONObject.NULL : m); }
            return o.toString();
        } catch (Exception e) { Log.w(TAG, "faceIdentify", e); try { return o.put("ok", false).put("error", String.valueOf(e.getMessage())).toString(); } catch (Exception x) { return "{}"; } }
    }

    /** [{name, title, samples}] */
    @JavascriptInterface
    public String faceList() {
        JSONArray out = new JSONArray();
        try {
            JSONArray all = faces().people();
            for (int i = 0; i < all.length(); i++) {
                JSONObject p = all.getJSONObject(i);
                out.put(new JSONObject().put("name", p.optString("name")).put("title", p.optString("title")).put("samples", p.optJSONArray("samples") == null ? 0 : p.optJSONArray("samples").length()));
            }
        } catch (Exception e) { Log.w(TAG, "faceList", e); }
        return out.toString();
    }

    @JavascriptInterface public boolean faceForget(String name) { return faces().forget(name); }

    // ================================================================== phone control (PhoneControlService)
    private PhoneControlService ctl() { return PhoneControlService.instance; }
    private String needControl() { return PhoneControlService.isEnabled(a) ? "starting" : "need-control"; }

    @JavascriptInterface public String screenRead() { PhoneControlService s = ctl(); return s == null ? needControl() : s.readScreen(120); }
    @JavascriptInterface public String screenTap(String target, boolean longPress) { PhoneControlService s = ctl(); return s == null ? needControl() : s.tap(target, longPress); }
    @JavascriptInterface public String screenType(String text, String target, boolean submit) { PhoneControlService s = ctl(); return s == null ? needControl() : s.type(text, target, submit); }
    @JavascriptInterface public String screenScroll(String dir) { PhoneControlService s = ctl(); return s == null ? needControl() : s.scroll(dir); }
    @JavascriptInterface public String press(String what) { PhoneControlService s = ctl(); return s == null ? needControl() : s.press(what); }
    /** A JPEG of the screen (base64), "" if it failed, or need-control. Android 11+. */
    @JavascriptInterface public String screenshot() {
        PhoneControlService s = ctl();
        if (s == null) return needControl();
        if (Build.VERSION.SDK_INT < 30) return "old-android";
        return s.screenshotJpeg();
    }
    @JavascriptInterface public String currentApp() { return PhoneControlService.currentPackage; }
}
