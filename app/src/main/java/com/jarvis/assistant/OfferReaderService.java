package com.jarvis.assistant;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;

/**
 * Offer reader. When the DoorDash Dasher or Uber Driver app shows a delivery offer, reads the words on that card and has
 * Jarvis say "take it", "your call" or "pass", with the pay per mile and per hour.
 * Only those two apps (see res/xml/offer_reader.xml). It never taps, accepts or declines anything; the driver does that.
 * Nothing it reads is stored or sent anywhere: the last screen is kept in memory only, for Settings > Offer reader.
 */
public class OfferReaderService extends AccessibilityService {
    public interface Listener { void onOffer(OfferParser.Offer o, String spoken); }
    public static volatile Listener listener;                  // set by Bridge while Jarvis is open
    public static volatile String lastScreen = "";
    public static volatile long lastScreenAt = 0;
    public static volatile boolean running = false;

    static final String PREFS = "jarvis_offers";
    private static final String DOORDASH = "com.doordash.driverapp", UBER = "com.ubercab.driver";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private String pendingPkg = "", lastKey = "";
    private long lastKeyAt = 0;
    private TextToSpeech fallbackTts;
    private final Runnable scan = new Runnable() { @Override public void run() { scanNow(); } };

    @Override protected void onServiceConnected() { running = true; }
    @Override public boolean onUnbind(android.content.Intent i) { running = false; return super.onUnbind(i); }
    @Override public void onDestroy() { running = false; if (fallbackTts != null) fallbackTts.shutdown(); super.onDestroy(); }
    @Override public void onInterrupt() { }

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        CharSequence p = e == null ? null : e.getPackageName();
        if (p == null) return;
        String pkg = p.toString();
        if (!DOORDASH.equals(pkg) && !UBER.equals(pkg)) return;
        if (!getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", true)) return;
        pendingPkg = pkg;
        handler.removeCallbacks(scan);
        handler.postDelayed(scan, 350);                       // let the offer card finish drawing
    }

    private void scanNow() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        CharSequence rp = root.getPackageName();
        String pkg = rp == null ? pendingPkg : rp.toString();
        if (!DOORDASH.equals(pkg) && !UBER.equals(pkg)) return;
        List<String> texts = new ArrayList<>();
        collect(root, texts, 0);
        StringBuilder sb = new StringBuilder();
        for (String t : texts) { if (sb.length() > 1500) break; if (sb.length() > 0) sb.append(" | "); sb.append(t); }
        lastScreen = sb.toString();
        lastScreenAt = System.currentTimeMillis();

        OfferParser.Offer o = OfferParser.parse(pkg, texts, Calendar.getInstance());
        if (o == null) return;
        long now = SystemClock.elapsedRealtime();
        if (o.key().equals(lastKey) && now - lastKeyAt < 90_000) return;                 // same card redrawn: say it once
        lastKey = o.key(); lastKeyAt = now;

        SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String spoken = OfferParser.spoken(o, sp.getFloat("min_hr", 18f), sp.getFloat("min_mi", 1.5f), sp.getString("currency", "$"));
        Listener l = listener;
        if (l != null) l.onOffer(o, spoken);
        else speakFallback(spoken);                           // Jarvis's screen isn't open: say it with the phone's voice
    }

    private void collect(AccessibilityNodeInfo n, List<String> out, int depth) {
        if (n == null || depth > 40 || out.size() > 300) return;
        CharSequence t = n.getText();
        if (t == null || t.length() == 0) t = n.getContentDescription();
        if (t != null && t.length() > 0 && t.length() < 200) out.add(t.toString());
        for (int i = 0; i < n.getChildCount(); i++) collect(n.getChild(i), out, depth + 1);
    }

    private void speakFallback(final String text) {
        if (fallbackTts == null) {
            fallbackTts = new TextToSpeech(getApplicationContext(), new TextToSpeech.OnInitListener() {
                @Override public void onInit(int status) {
                    if (status == TextToSpeech.SUCCESS) { fallbackTts.setLanguage(Locale.US); fallbackTts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "offer"); }
                }
            });
        } else fallbackTts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "offer");
    }

    /** Is the offer reader switched on in Android's accessibility settings? */
    public static boolean isEnabled(Context c) {
        try {
            String on = android.provider.Settings.Secure.getString(c.getContentResolver(), android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            return on != null && on.contains(c.getPackageName() + "/") && on.contains("OfferReaderService");
        } catch (Exception e) { return false; }
    }
}
