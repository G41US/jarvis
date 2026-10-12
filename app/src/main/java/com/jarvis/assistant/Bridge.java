package com.jarvis.assistant;

import android.app.Activity;
import android.app.SearchManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Bundle;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Everything the page cannot do on its own. The page reaches this as window.AndroidBridge.
 * All methods return quickly; results come back to the page through window.__httpResult / window.__ttsEvent.
 */
public class Bridge {
    private static final String TAG = "JarvisBridge";
    private static final int MAX_BODY = 6 * 1024 * 1024;

    private final Activity activity;
    private final WebView web;
    private final ExecutorService pool = Executors.newCachedThreadPool();   // streams can stay open for a while

    // ---- text to speech
    private TextToSpeech tts;
    private boolean ttsReady = false, ttsFailed = false;
    private final List<Object[]> ttsPending = new ArrayList<>();   // {id, text, rate, pitch} spoken once the engine is up
    private String wantedVoice = "";
    private AudioFocusRequest focus;
    private int speaking = 0;

    // ---- microphone + wake word (VoiceEngine) and streaming HTTP
    private VoiceEngine voice;
    private final Map<Integer, HttpURLConnection> live = new HashMap<>();

    public Bridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        initTts();
    }

    public void destroy() {
        try { if (tts != null) { tts.stop(); tts.shutdown(); } } catch (Exception ignored) { }
        try { if (voice != null) voice.stop(); } catch (Exception ignored) { }
        pool.shutdownNow();
    }

    /** Called by MainActivity when the microphone permission arrives. */
    public void onMicPermission() { js("window.__jvMic&&window.__jvMic('permission')"); }

    // ------------------------------------------------------------------ helpers
    private void js(final String code) {
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                try { web.evaluateJavascript(code, null); } catch (Exception e) { Log.w(TAG, "js failed", e); }
            }
        });
    }

    private void ttsEvent(long id, String ev) { js("window.__ttsEvent&&window.__ttsEvent(" + id + ",'" + ev + "')"); }

    // ------------------------------------------------------------------ HTTP (no CORS, real User-Agent)
    @JavascriptInterface
    public void httpRequest(final int id, final String method, final String url, final String headersJson, final String body, final int timeoutMs) {
        pool.execute(new Runnable() {
            @Override public void run() {
                int status = 0;
                String text = "";
                HttpURLConnection c = null;
                try {
                    if (url == null || !url.startsWith("https://")) throw new IllegalArgumentException("https only");
                    c = (HttpURLConnection) new URL(url).openConnection();
                    int t = Math.max(3000, Math.min(timeoutMs > 0 ? timeoutMs : 12000, 60000));
                    c.setConnectTimeout(t);
                    c.setReadTimeout(t);
                    c.setRequestMethod(method == null || method.isEmpty() ? "GET" : method.toUpperCase(Locale.ROOT));
                    c.setInstanceFollowRedirects(true);
                    JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                    Iterator<String> keys = h.keys();
                    while (keys.hasNext()) { String k = keys.next(); c.setRequestProperty(k, h.optString(k)); }
                    if (body != null && !body.isEmpty() && !"GET".equals(c.getRequestMethod())) {
                        c.setDoOutput(true);
                        byte[] b = body.getBytes(StandardCharsets.UTF_8);
                        c.setFixedLengthStreamingMode(b.length);
                        OutputStream os = c.getOutputStream();
                        os.write(b);
                        os.close();
                    }
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    if (in != null) {
                        ByteArrayOutputStream bo = new ByteArrayOutputStream();
                        byte[] buf = new byte[16384];
                        int n, total = 0;
                        while ((n = in.read(buf)) > 0 && total < MAX_BODY) { bo.write(buf, 0, n); total += n; }
                        in.close();
                        text = bo.toString("UTF-8");
                    }
                } catch (Exception e) {
                    Log.w(TAG, "http " + method + " failed: " + e);
                    status = 0;
                    text = "";
                } finally {
                    if (c != null) c.disconnect();
                }
                js("window.__httpResult(" + id + "," + status + "," + JSONObject.quote(text) + ")");
            }
        });
    }

    // ------------------------------------------------------------------ speech out
    private void initTts() {
        tts = new TextToSpeech(activity.getApplicationContext(), new TextToSpeech.OnInitListener() {
            @Override public void onInit(int status) {
                if (status != TextToSpeech.SUCCESS) {
                    ttsFailed = true;
                    synchronized (ttsPending) { for (Object[] p : ttsPending) ttsEvent((Long) p[0], "error"); ttsPending.clear(); }
                    return;
                }
                try {
                    tts.setLanguage(Locale.getDefault());
                    tts.setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override public void onStart(String utteranceId) { }
                        @Override public void onDone(String utteranceId) { finished(utteranceId, "done"); }
                        @Override public void onError(String utteranceId) { finished(utteranceId, "error"); }
                        @Override public void onStop(String utteranceId, boolean interrupted) { finished(utteranceId, "done"); }
                    });
                } catch (Exception e) { Log.w(TAG, "tts setup", e); }
                ttsReady = true;
                applyVoiceNow();
                synchronized (ttsPending) { for (Object[] p : ttsPending) speakNow((Long) p[0], (String) p[1], (Float) p[2], (Float) p[3]); ttsPending.clear(); }
            }
        });
    }

    private void finished(String utteranceId, String ev) {
        try {
            long id = Long.parseLong(utteranceId.substring(1));
            synchronized (this) { speaking = Math.max(0, speaking - 1); if (speaking == 0) abandonFocus(); }
            ttsEvent(id, ev);
        } catch (Exception ignored) { }
    }

    private void takeFocus() {
        try {
            AudioManager am = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
            if (focus == null) {
                focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        .setOnAudioFocusChangeListener(new AudioManager.OnAudioFocusChangeListener() { @Override public void onAudioFocusChange(int change) { } })
                        .build();
            }
            am.requestAudioFocus(focus);
        } catch (Exception ignored) { }
    }

    private void abandonFocus() {
        try {
            if (focus != null) ((AudioManager) activity.getSystemService(Context.AUDIO_SERVICE)).abandonAudioFocusRequest(focus);
        } catch (Exception ignored) { }
    }

    private void speakNow(long id, String text, float rate, float pitch) {
        try {
            tts.setSpeechRate(Math.max(0.5f, Math.min(rate, 2.5f)));
            tts.setPitch(Math.max(0.5f, Math.min(pitch, 2.0f)));
            synchronized (this) { if (speaking == 0) takeFocus(); speaking++; }
            Bundle p = new Bundle();
            p.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
            int r = tts.speak(text, TextToSpeech.QUEUE_ADD, p, "u" + id);
            if (r != TextToSpeech.SUCCESS) finished("u" + id, "error");
        } catch (Exception e) {
            Log.w(TAG, "speak", e);
            ttsEvent(id, "error");
        }
    }

    @JavascriptInterface
    public void ttsSpeak(final int id, final String text, final double rate, final double pitch) {
        if (text == null || text.trim().isEmpty()) { ttsEvent(id, "done"); return; }
        if (ttsFailed) { ttsEvent(id, "error"); return; }
        if (!ttsReady) { synchronized (ttsPending) { ttsPending.add(new Object[]{(long) id, text, (float) rate, (float) pitch}); } return; }
        speakNow(id, text, (float) rate, (float) pitch);
    }

    @JavascriptInterface
    public void ttsStop() {
        try { if (tts != null && ttsReady) tts.stop(); } catch (Exception ignored) { }
        synchronized (this) { speaking = 0; }
        abandonFocus();
    }

    @JavascriptInterface
    public String ttsVoices() {
        JSONArray out = new JSONArray();
        try {
            if (tts == null || !ttsReady) return "[]";
            Set<Voice> all = tts.getVoices();
            if (all == null) return "[]";
            String myLang = Locale.getDefault().getLanguage();
            List<Voice> list = new ArrayList<>();
            for (Voice v : all) {
                String lang = v.getLocale() == null ? "" : v.getLocale().getLanguage();
                if (lang.equals(myLang) || lang.equals("en")) list.add(v);
            }
            Collections.sort(list, new java.util.Comparator<Voice>() {
                @Override public int compare(Voice a, Voice b) {
                    int q = b.getQuality() - a.getQuality();
                    return q != 0 ? q : a.getName().compareTo(b.getName());
                }
            });
            int n = 0;
            for (Voice v : list) {
                if (n++ >= 40) break;
                JSONObject o = new JSONObject();
                o.put("id", v.getName());
                o.put("label", prettyVoice(v));
                o.put("lang", v.getLocale() == null ? "" : v.getLocale().toLanguageTag());
                out.put(o);
            }
        } catch (Exception e) { Log.w(TAG, "voices", e); }
        return out.toString();
    }

    private static String prettyVoice(Voice v) {
        String name = v.getName();
        String tag = v.getLocale() == null ? "" : v.getLocale().getDisplayCountry(Locale.ENGLISH);
        String net = v.isNetworkConnectionRequired() ? " (online)" : "";
        return (tag.isEmpty() ? name : tag + " • " + name) + net;
    }

    @JavascriptInterface
    public void ttsSetVoice(final String id) {
        wantedVoice = id == null ? "" : id;
        if (ttsReady) applyVoiceNow();
    }

    private void applyVoiceNow() {
        try {
            if (wantedVoice.isEmpty()) return;
            for (Voice v : tts.getVoices()) { if (v.getName().equals(wantedVoice)) { tts.setVoice(v); return; } }
        } catch (Exception e) { Log.w(TAG, "setVoice", e); }
    }

    // ------------------------------------------------------------------ opening things
    private boolean launch(Intent i) {
        try { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); activity.startActivity(i); return true; }
        catch (Exception e) { Log.w(TAG, "launch failed: " + i, e); return false; }
    }

    @JavascriptInterface
    public void openUrl(final String url) {
        if (url == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    Uri u = Uri.parse(url.trim());
                    String s = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
                    if (!(s.equals("https") || s.equals("http") || s.equals("geo") || s.equals("tel") || s.equals("sms") || s.equals("smsto")
                            || s.equals("mailto") || s.equals("google.navigation") || s.equals("comgooglemaps") || s.equals("maps"))) return;
                    launch(new Intent(s.equals("tel") ? Intent.ACTION_DIAL : Intent.ACTION_VIEW, u));
                } catch (Exception e) { Log.w(TAG, "openUrl", e); }
            }
        });
    }

    private static String norm(String s) { return s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", ""); }

    @JavascriptInterface
    public String openApp(final String name) {
        try {
            String want = norm(name == null ? "" : name).replaceFirst("^(the|my)", "");
            if (want.isEmpty()) return "Which app?";
            if (want.equals("maps") || want.equals("googlemaps")) want = "maps";
            PackageManager pm = activity.getPackageManager();
            Intent q = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> apps = pm.queryIntentActivities(q, 0);
            ResolveInfo best = null;
            int bestScore = 0;
            for (ResolveInfo ri : apps) {
                String label = norm(String.valueOf(ri.loadLabel(pm)));
                int score = label.equals(want) ? 3 : label.startsWith(want) ? 2 : label.contains(want) ? 1 : 0;
                if (score > bestScore) { bestScore = score; best = ri; }
            }
            if (best == null) return "I couldn't find an app called " + name + ".";
            final Intent li = pm.getLaunchIntentForPackage(best.activityInfo.packageName);
            if (li == null) return "I couldn't open " + name + ".";
            activity.runOnUiThread(new Runnable() { @Override public void run() { launch(li); } });
            return "ok";
        } catch (Exception e) { return "I couldn't open that app."; }
    }

    // ------------------------------------------------------------------ music
    private void mediaKey(int code) {
        AudioManager am = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
        am.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, code));
        am.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, code));
    }

    @JavascriptInterface
    public String media(final String action, final String query, final String pkg) {
        try {
            if ("play".equals(action)) { mediaKey(KeyEvent.KEYCODE_MEDIA_PLAY); return "ok"; }
            if ("pause".equals(action)) { mediaKey(KeyEvent.KEYCODE_MEDIA_PAUSE); return "ok"; }
            if ("next".equals(action)) { mediaKey(KeyEvent.KEYCODE_MEDIA_NEXT); return "ok"; }
            if ("previous".equals(action)) { mediaKey(KeyEvent.KEYCODE_MEDIA_PREVIOUS); return "ok"; }
            if ("play_search".equals(action)) {
                final Intent i = new Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH);
                i.putExtra(SearchManager.QUERY, query == null ? "" : query);
                i.putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*");
                boolean pkgInstalled = false;
                if (pkg != null && !pkg.isEmpty()) {
                    try { activity.getPackageManager().getPackageInfo(pkg, 0); pkgInstalled = true; } catch (Exception ignored) { }
                    if (pkgInstalled) i.setPackage(pkg);
                }
                activity.runOnUiThread(new Runnable() { @Override public void run() { launch(i); } });
                return "ok";
            }
            return "I can't do that with music here.";
        } catch (Exception e) { return "I couldn't control the music app."; }
    }

    // ------------------------------------------------------------------ phone state
    @JavascriptInterface
    public String battery() {
        JSONObject o = new JSONObject();
        try {
            Intent b = activity.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (b != null) {
                int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                int st = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                o.put("level", scale > 0 ? Math.round(level * 100f / scale) : level);
                o.put("charging", st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL);
            }
            ConnectivityManager cm = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm.getActiveNetwork();
            NetworkCapabilities nc = n == null ? null : cm.getNetworkCapabilities(n);
            String net = "";
            if (nc != null) net = nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "Wi-Fi" : nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "mobile data" : "a network";
            o.put("network", net);
        } catch (Exception e) { Log.w(TAG, "battery", e); }
        return o.toString();
    }

    // ------------------------------------------------------------------ streaming HTTP (Groq / Jarvis proxy)
    @JavascriptInterface
    public void httpStream(final int id, final String method, final String url, final String headersJson, final String bodyB64, final int timeoutMs) {
        pool.execute(new Runnable() {
            @Override public void run() {
                HttpURLConnection c = null;
                String err = "";
                boolean headed = false;
                try {
                    if (url == null || !url.startsWith("https://")) throw new IllegalArgumentException("https only");
                    c = (HttpURLConnection) new URL(url).openConnection();
                    synchronized (live) { live.put(id, c); }
                    int t = Math.max(5000, Math.min(timeoutMs > 0 ? timeoutMs : 60000, 120000));
                    c.setConnectTimeout(Math.min(t, 15000));
                    c.setReadTimeout(t);
                    c.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
                    JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                    Iterator<String> keys = h.keys();
                    while (keys.hasNext()) { String k = keys.next(); c.setRequestProperty(k, h.optString(k)); }
                    if (bodyB64 != null && !bodyB64.isEmpty()) {
                        byte[] b = java.util.Base64.getDecoder().decode(bodyB64);
                        c.setDoOutput(true);
                        c.setFixedLengthStreamingMode(b.length);
                        OutputStream os = c.getOutputStream();
                        os.write(b);
                        os.close();
                    }
                    int status = c.getResponseCode();
                    js("window.__httpHead&&window.__httpHead(" + id + "," + status + ")");
                    headed = true;
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    if (in != null) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            byte[] part = java.util.Arrays.copyOf(buf, n);
                            js("window.__httpChunk&&window.__httpChunk(" + id + ",'" + java.util.Base64.getEncoder().encodeToString(part) + "')");
                        }
                        in.close();
                    }
                } catch (Exception e) {
                    err = String.valueOf(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
                    Log.w(TAG, "stream " + url + " failed: " + err);
                } finally {
                    synchronized (live) { live.remove(id); }
                    if (c != null) c.disconnect();
                }
                js("window.__httpEnd&&window.__httpEnd(" + id + "," + (headed && err.isEmpty() ? "''" : JSONObject.quote(err.isEmpty() ? "network error" : err)) + ")");
            }
        });
    }

    @JavascriptInterface
    public void httpAbort(final int id) {
        final HttpURLConnection c;
        synchronized (live) { c = live.remove(id); }
        if (c != null) pool.execute(new Runnable() { @Override public void run() { try { c.disconnect(); } catch (Exception ignored) { } } });
    }

    // ------------------------------------------------------------------ microphone + "Hey Jarvis"
    private final VoiceEngine.Listener voiceOut = new VoiceEngine.Listener() {
        @Override public void onWake(float score) { js("window.__jvWake&&window.__jvWake(" + score + ")"); }
        @Override public void onLevel(float rms, float score, float speech) { js("window.__jvLevel&&window.__jvLevel(" + Math.round(rms) + "," + score + "," + speech + ")"); }
        @Override public void onPcm(short[] pcm, float speech) {
            byte[] b = new byte[pcm.length * 2];
            for (int i = 0; i < pcm.length; i++) { b[2 * i] = (byte) (pcm[i] & 0xff); b[2 * i + 1] = (byte) ((pcm[i] >> 8) & 0xff); }
            js("window.__jvPcm&&window.__jvPcm('" + java.util.Base64.getEncoder().encodeToString(b) + "'," + speech + ")");
        }
        @Override public void onState(String state) { js("window.__jvMic&&window.__jvMic(" + JSONObject.quote(state) + ")"); }
    };

    /** Starts the native microphone. Returns "ok", "no-permission" or an error. */
    @JavascriptInterface
    public String micStart() {
        if (activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return "no-permission";
        try {
            synchronized (this) { if (voice == null) voice = new VoiceEngine(activity, voiceOut); }
            voice.start();
            return "ok";
        } catch (Exception e) { return "error: " + e.getMessage(); }
    }

    @JavascriptInterface public void micStop() { if (voice != null) voice.stop(); }
    @JavascriptInterface public void setListening(boolean on) { if (voice != null) voice.setListening(on); }
    @JavascriptInterface public void setSpeaking(boolean on) { if (voice != null) voice.setSpeaking(on); }
    @JavascriptInterface public void setMuted(boolean on) { if (voice != null) voice.setMuted(on); }
    @JavascriptInterface public void setWakeThreshold(float t) { if (voice != null) voice.setThreshold(t); }

    @JavascriptInterface
    public String micStatus() {
        JSONObject o = new JSONObject();
        try {
            o.put("running", voice != null && voice.isRunning());
            o.put("wake", voice != null && voice.hasWakeWord());
            o.put("vad", voice != null && voice.hasVad());
            o.put("wakeError", voice == null ? "" : voice.wakeError());
            o.put("permission", activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
        } catch (Exception ignored) { }
        return o.toString();
    }

    /** Short sine chime (wake / end of session / timers), played natively so it always sounds. */
    @JavascriptInterface
    public void tone(final double freq, final int ms, final double volume) {
        pool.execute(new Runnable() {
            @Override public void run() {
                try {
                    int rate = 22050, n = Math.max(1, Math.min(rate, rate * Math.max(20, ms) / 1000));
                    short[] pcm = new short[n];
                    double vol = Math.max(0.02, Math.min(1.0, volume * 6.0));          // page volumes (~0.06) are for a quiet web tone
                    for (int i = 0; i < n; i++) {
                        double env = Math.min(1.0, Math.min(i / (rate * 0.005), (n - i) / (rate * 0.03)));
                        pcm[i] = (short) (Math.sin(2 * Math.PI * freq * i / rate) * env * vol * 32767);
                    }
                    android.media.AudioTrack t = new android.media.AudioTrack.Builder()
                            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                            .setAudioFormat(new android.media.AudioFormat.Builder().setEncoding(android.media.AudioFormat.ENCODING_PCM_16BIT)
                                    .setSampleRate(rate).setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO).build())
                            .setTransferMode(android.media.AudioTrack.MODE_STATIC).setBufferSizeInBytes(n * 2).build();
                    t.write(pcm, 0, n);
                    t.play();
                    Thread.sleep(ms + 80L);
                    t.release();
                } catch (Exception e) { Log.w(TAG, "tone", e); }
            }
        });
    }

    /** Lets the page keep the screen awake while it is on screen. */
    @JavascriptInterface
    public void keepAwake(final boolean on) {
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                if (on) activity.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else activity.getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }
}
