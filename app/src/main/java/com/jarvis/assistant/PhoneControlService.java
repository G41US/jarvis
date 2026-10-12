package com.jarvis.assistant;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * "Jarvis phone control": lets Jarvis read what's on the screen and tap, type, scroll and press Back / Home for you.
 * The user switches it on in Android's accessibility settings. It does nothing on its own: every action comes from a
 * request the user made to Jarvis. It never acts inside the DoorDash Dasher or Uber Driver apps, and never types into
 * password fields.
 */
public class PhoneControlService extends AccessibilityService {
    private static final String TAG = "JarvisControl";
    static volatile PhoneControlService instance;
    static volatile String currentPackage = "";
    /** Apps Jarvis may read but never touch (their terms forbid automation). */
    static final String[] HANDS_OFF = {"com.doordash.driverapp", "com.ubercab.driver", "com.grubhub.driver"};

    private final List<AccessibilityNodeInfo> lastNodes = new ArrayList<>();

    @Override protected void onServiceConnected() { instance = this; }
    @Override public boolean onUnbind(android.content.Intent i) { instance = null; return super.onUnbind(i); }
    @Override public void onDestroy() { instance = null; super.onDestroy(); }
    @Override public void onInterrupt() { }

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e != null && e.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && e.getPackageName() != null) {
            String p = e.getPackageName().toString();
            if (!p.equals("com.android.systemui")) currentPackage = p;
        }
    }

    static boolean isEnabled(Context c) {
        try {
            String s = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            String me = new ComponentName(c, PhoneControlService.class).flattenToString();
            return s != null && s.toLowerCase(Locale.ROOT).contains(me.toLowerCase(Locale.ROOT));
        } catch (Exception e) { return false; }
    }

    private String appLabel(String pkg) {
        try { PackageManager pm = getPackageManager(); ApplicationInfo ai = pm.getApplicationInfo(pkg, 0); return String.valueOf(pm.getApplicationLabel(ai)); }
        catch (Exception e) { return pkg; }
    }

    private static boolean handsOff(CharSequence pkg) {
        if (pkg == null) return false;
        for (String p : HANDS_OFF) if (p.contentEquals(pkg)) return true;
        return false;
    }

    // ------------------------------------------------------------------ reading the screen
    private AccessibilityNodeInfo root() {
        AccessibilityNodeInfo r = getRootInActiveWindow();
        if (r != null) return r;
        try { for (AccessibilityWindowInfo w : getWindows()) if (w.isActive() && w.getRoot() != null) return w.getRoot(); } catch (Exception ignored) { }
        return null;
    }

    private static String clean(CharSequence s) { return s == null ? "" : s.toString().replaceAll("\\s+", " ").trim(); }

    private static String label(AccessibilityNodeInfo n) {
        String t = clean(n.getText()), d = clean(n.getContentDescription());
        if (t.isEmpty() && Build.VERSION.SDK_INT >= 26) t = clean(n.getHintText());
        if (t.isEmpty()) return d;
        if (!d.isEmpty() && !d.equalsIgnoreCase(t) && d.length() < 60) return t + " (" + d + ")";
        return t;
    }

    private static String kind(AccessibilityNodeInfo n) {
        String cls = n.getClassName() == null ? "" : n.getClassName().toString();
        if (n.isEditable()) return "field";
        if (cls.endsWith("CheckBox") || cls.endsWith("Switch") || n.isCheckable()) return n.isChecked() ? "switch on" : "switch off";
        if (cls.endsWith("Button") || cls.endsWith("ImageButton")) return "button";
        if (n.isClickable()) return "tap";
        return "text";
    }

    /** A numbered list of what's on screen, for the AI: "[3] button: Send". Numbers stay valid until the next read. */
    public String readScreen(int max) {
        lastNodes.clear();
        AccessibilityNodeInfo r = root();
        if (r == null) return "I can't see the screen right now.";
        String pkg = r.getPackageName() == null ? currentPackage : r.getPackageName().toString();
        StringBuilder sb = new StringBuilder("App on screen: ").append(appLabel(pkg)).append(handsOff(pkg) ? " (read only: I don't operate this app)" : "").append('\n');
        walk(r, sb, Math.max(20, Math.min(max, 160)), 0);
        if (lastNodes.isEmpty()) sb.append("(nothing readable)");
        return sb.length() > 6000 ? sb.substring(0, 6000) + "\n…" : sb.toString();
    }

    private void walk(AccessibilityNodeInfo n, StringBuilder sb, int max, int depth) {
        if (n == null || lastNodes.size() >= max || depth > 40) return;
        if (!n.isVisibleToUser()) return;
        String l = label(n);
        boolean useful = !l.isEmpty() && (n.isClickable() || n.isEditable() || n.isCheckable() || n.getChildCount() == 0 || n.isLongClickable());
        if (n.isEditable() && l.isEmpty()) { l = "(empty)"; useful = true; }
        if (useful) {
            lastNodes.add(n);
            String k = kind(n);
            sb.append('[').append(lastNodes.size()).append("] ").append(k).append(": ").append(n.isPassword() ? "(password)" : (l.length() > 140 ? l.substring(0, 140) + "…" : l));
            if (n.isScrollable()) sb.append(" (scrolls)");
            sb.append('\n');
        }
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), sb, max, depth + 1);
    }

    // ------------------------------------------------------------------ finding a target
    private AccessibilityNodeInfo find(String target) {
        if (target == null) return null;
        String t = target.trim();
        if (t.matches("\\[?\\d+\\]?")) {
            int i = Integer.parseInt(t.replaceAll("\\D", "")) - 1;
            if (i >= 0 && i < lastNodes.size()) { AccessibilityNodeInfo n = lastNodes.get(i); if (n.refresh()) return n; }
        }
        String want = t.toLowerCase(Locale.ROOT).replaceAll("^\\[\\d+\\]\\s*", "");
        AccessibilityNodeInfo r = root();
        if (r == null) return null;
        List<AccessibilityNodeInfo> all = new ArrayList<>();
        collect(r, all, 0);
        AccessibilityNodeInfo best = null;
        int bestScore = 0;
        for (AccessibilityNodeInfo n : all) {
            String l = label(n).toLowerCase(Locale.ROOT);
            if (l.isEmpty()) continue;
            int s = l.equals(want) ? 4 : l.startsWith(want) ? 3 : l.contains(want) ? 2 : 0;
            if (s == 0) continue;
            if (n.isClickable() || n.isEditable()) s += 1;
            if (s > bestScore) { bestScore = s; best = n; }
        }
        return best;
    }

    private void collect(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> out, int depth) {
        if (n == null || depth > 40 || out.size() > 600) return;
        if (n.isVisibleToUser()) out.add(n);
        for (int i = 0; i < n.getChildCount(); i++) collect(n.getChild(i), out, depth + 1);
    }

    // ------------------------------------------------------------------ acting
    private String refuseHere(AccessibilityNodeInfo n) {
        CharSequence p = n == null ? currentPackage : n.getPackageName();
        if (handsOff(p)) return "I don't operate the delivery apps themselves. Tap that one yourself.";
        return null;
    }

    public String tap(String target, boolean longPress) {
        AccessibilityNodeInfo n = find(target);
        if (n == null) return "I can't find \"" + target + "\" on the screen. Read the screen again first.";
        String no = refuseHere(n);
        if (no != null) return no;
        int action = longPress ? AccessibilityNodeInfo.ACTION_LONG_CLICK : AccessibilityNodeInfo.ACTION_CLICK;
        AccessibilityNodeInfo c = n;
        while (c != null && !(longPress ? c.isLongClickable() : c.isClickable())) c = c.getParent();
        if (c != null && c.performAction(action)) return "Tapped " + label(n) + ".";
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        if (b.isEmpty()) return "That item isn't tappable.";
        return gesture(b.exactCenterX(), b.exactCenterY(), b.exactCenterX(), b.exactCenterY(), longPress ? 700 : 60) ? "Tapped " + label(n) + "." : "The tap didn't go through.";
    }

    public String type(String text, String target, boolean submit) {
        AccessibilityNodeInfo n = target == null || target.trim().isEmpty() ? null : find(target);
        if (n == null) {
            AccessibilityNodeInfo r = root();
            if (r != null) n = r.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (n == null && r != null) { List<AccessibilityNodeInfo> all = new ArrayList<>(); collect(r, all, 0); for (AccessibilityNodeInfo x : all) if (x.isEditable()) { n = x; break; } }
        }
        if (n == null) return "I don't see a text box to type in.";
        String no = refuseHere(n);
        if (no != null) return no;
        if (n.isPassword()) return "That's a password box. I won't type passwords.";
        n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text == null ? "" : text);
        boolean ok = n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        if (ok && submit && Build.VERSION.SDK_INT >= 30) n.performAction(android.R.id.accessibilityActionImeEnter);
        return ok ? "Typed it." : "That box wouldn't take the text.";
    }

    public String scroll(String direction) {
        String d = direction == null ? "down" : direction.toLowerCase(Locale.ROOT);
        if (handsOff(currentPackage)) return refuseHere(null);
        AccessibilityNodeInfo r = root();
        AccessibilityNodeInfo best = null;
        if (r != null) {
            List<AccessibilityNodeInfo> all = new ArrayList<>();
            collect(r, all, 0);
            int area = 0;
            Rect b = new Rect();
            for (AccessibilityNodeInfo n : all) if (n.isScrollable()) { n.getBoundsInScreen(b); int a = b.width() * b.height(); if (a > area) { area = a; best = n; } }
        }
        boolean forward = d.startsWith("down") || d.startsWith("right") || d.startsWith("next");
        if (best != null && best.performAction(forward ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)) return "Scrolled " + d + ".";
        android.util.DisplayMetrics m = getResources().getDisplayMetrics();
        float cx = m.widthPixels / 2f, cy = m.heightPixels / 2f, dy = m.heightPixels * 0.3f, dx = m.widthPixels * 0.35f;
        boolean ok;
        if (d.startsWith("left") || d.startsWith("right")) ok = gesture(cx + (forward ? dx : -dx), cy, cx - (forward ? dx : -dx), cy, 300);
        else ok = gesture(cx, cy + (forward ? dy : -dy), cx, cy - (forward ? dy : -dy), 300);
        return ok ? "Scrolled " + d + "." : "I couldn't scroll here.";
    }

    private boolean gesture(float x1, float y1, float x2, float y2, long ms) {
        try {
            Path p = new Path();
            p.moveTo(x1, y1);
            p.lineTo(x2, y2);
            GestureDescription g = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(p, 0, Math.max(1, ms))).build();
            final CountDownLatch done = new CountDownLatch(1);
            final boolean[] ok = {false};
            boolean sent = dispatchGesture(g, new GestureResultCallback() {
                @Override public void onCompleted(GestureDescription d) { ok[0] = true; done.countDown(); }
                @Override public void onCancelled(GestureDescription d) { done.countDown(); }
            }, null);
            if (!sent) return false;
            done.await(2, TimeUnit.SECONDS);
            return ok[0];
        } catch (Exception e) { Log.w(TAG, "gesture", e); return false; }
    }

    public String press(String what) {
        String w = what == null ? "" : what.toLowerCase(Locale.ROOT).replaceAll("[^a-z]", "");
        int a;
        switch (w) {
            case "back": a = GLOBAL_ACTION_BACK; break;
            case "home": a = GLOBAL_ACTION_HOME; break;
            case "recents": case "recentapps": case "overview": case "switchapps": a = GLOBAL_ACTION_RECENTS; break;
            case "notifications": a = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "quicksettings": a = GLOBAL_ACTION_QUICK_SETTINGS; break;
            case "power": case "powerdialog": case "powermenu": a = GLOBAL_ACTION_POWER_DIALOG; break;
            case "lock": case "lockscreen": case "lockphone": if (Build.VERSION.SDK_INT < 28) return "Locking needs Android 9 or newer."; a = GLOBAL_ACTION_LOCK_SCREEN; break;
            case "screenshot": case "takescreenshot": if (Build.VERSION.SDK_INT < 28) return "Screenshots need Android 9 or newer."; a = GLOBAL_ACTION_TAKE_SCREENSHOT; break;
            case "splitscreen": a = GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN; break;
            default: return "I can press back, home, recents, notifications, quick settings, lock, screenshot or the power menu.";
        }
        return performGlobalAction(a) ? "Done." : "That didn't work.";
    }

    /** A JPEG (base64) of the screen, for Jarvis's eyes. Android 11+. Blocks for up to 4 seconds. */
    public String screenshotJpeg() {
        if (Build.VERSION.SDK_INT < 30) return "";
        final AtomicReference<String> out = new AtomicReference<>("");
        final CountDownLatch done = new CountDownLatch(1);
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
                @Override public void onSuccess(ScreenshotResult r) {
                    try {
                        HardwareBuffer hb = r.getHardwareBuffer();
                        Bitmap hw = Bitmap.wrapHardwareBuffer(hb, r.getColorSpace());
                        if (hw != null) {
                            Bitmap sw = hw.copy(Bitmap.Config.ARGB_8888, false);
                            float k = Math.min(1f, 1280f / Math.max(sw.getWidth(), sw.getHeight()));
                            Bitmap small = k < 1f ? Bitmap.createScaledBitmap(sw, Math.round(sw.getWidth() * k), Math.round(sw.getHeight() * k), true) : sw;
                            ByteArrayOutputStream bo = new ByteArrayOutputStream();
                            small.compress(Bitmap.CompressFormat.JPEG, 80, bo);
                            out.set(java.util.Base64.getEncoder().encodeToString(bo.toByteArray()));
                        }
                        hb.close();
                    } catch (Exception e) { Log.w(TAG, "screenshot", e); }
                    done.countDown();
                }
                @Override public void onFailure(int code) { Log.w(TAG, "screenshot failed " + code); done.countDown(); }
            });
            done.await(4, TimeUnit.SECONDS);
        } catch (Exception e) { Log.w(TAG, "screenshot", e); }
        return out.get();
    }
}
