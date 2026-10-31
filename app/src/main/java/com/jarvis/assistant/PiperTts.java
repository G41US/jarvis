package com.jarvis.assistant;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.util.Log;

import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig;

import org.json.JSONObject;

import java.io.File;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * Jarvis's PC voices (Piper "Alan" and "Amy") on the phone, through sherpa-onnx.
 * Sentences are generated and played as they come, so speech starts before the whole reply is synthesised.
 */
public final class PiperTts {
    public interface Events {
        void onDone(long id, boolean ok);
        /** The natural voice couldn't be reached and no PC voice is downloaded: say it with the phone's voice. */
        void onFallback(long id, String text);
        void onStatus(String json);
    }

    private static final String TAG = "JarvisPiper";
    /** The PC speaks with Piper length_scale 0.88; sherpa's speed is 1 / length_scale. */
    private static final float PC_SPEED = 1f / 0.88f;

    private final File root;
    private final Events events;
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private final LinkedBlockingQueue<long[]> queue = new LinkedBlockingQueue<>();      // {id}, text kept in a map
    private final ConcurrentHashMap<Long, String> texts = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> state = new ConcurrentHashMap<>();   // name -> ready / downloading:NN / error:...
    private final Thread worker;
    private volatile String active = "";
    private volatile boolean cancel = false, running = true;
    private OfflineTts tts;
    private String loaded = "";
    private volatile String failed = "";                                        // a voice that would not load (corrupt download, out of memory)
    private AudioTrack track;
    // how loud he is, every HOP samples of the sentence being played: the face's mouth follows it (level())
    private static final int HOP = 512;
    private volatile float[] env = new float[256];
    private volatile int envLen = 0;
    private volatile long envBase = 0;
    private volatile float speed = 1f;                                        // the user's speaking speed (1 = normal)
    public void setSpeed(float s) { speed = Math.max(0.6f, Math.min(1.6f, s)); }

    /** Loudness (RMS) of what the speaker is playing right now; 0 when quiet. */
    public float level() {
        AudioTrack t = track; int n = envLen; if (t == null || n == 0) return 0f;
        try { long i = ((t.getPlaybackHeadPosition() & 0xffffffffL) - envBase) / HOP; return i >= 0 && i < n ? env[(int) i] : 0f; }
        catch (Exception e) { return 0f; }
    }

    public PiperTts(File root, Events events) {
        this.root = root;
        this.events = events;
        for (String v : new String[]{"alan", "amy"}) state.put(v, VoicePack.isReady(root, v) ? "ready" : "missing");
        worker = new Thread(this::loop, "jarvis-piper");
        worker.start();
    }

    public boolean isReady(String name) { return name != null && !name.isEmpty() && VoicePack.isReady(root, name); }
    public String active() { return active; }
    /** True when the PC voice can speak right now; otherwise the phone's own voice is used. */
    public boolean speaksNow() { return cloudOn() || (isReady(active) && !active.equals(failed)); }

    // ---- the natural voice (Groq Orpheus, through the Jarvis service): each sentence is fetched as soon as it's queued, so the
    //      next one is ready when the last finishes; it plays through the same speaker code (and mouth sync) as the PC voices
    private volatile String cloudUrl = "", cloudHeaders = "{}", cloudVoice = "";
    private final ExecutorService fetcher = Executors.newFixedThreadPool(2);
    private final ConcurrentHashMap<Long, java.util.concurrent.Future<float[][]>> fetched = new ConcurrentHashMap<>();
    private volatile long cloudPausedUntil = 0;                              // refused (terms not accepted, bad key): try again in a while
    private boolean cloudOn() { return !cloudUrl.isEmpty() && !cloudVoice.isEmpty() && System.currentTimeMillis() > cloudPausedUntil; }
    public void setCloud(String url, String headersJson, String voice) {
        cloudUrl = url == null ? "" : url; cloudHeaders = headersJson == null ? "{}" : headersJson; cloudVoice = voice == null ? "" : voice;
    }

    /** One sentence from the natural voice: {samples, {sampleRate}}. */
    private float[][] fetchCloud(String text) throws Exception {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(cloudUrl).openConnection();
        c.setRequestMethod("POST"); c.setDoOutput(true); c.setConnectTimeout(8000); c.setReadTimeout(20000);
        c.setRequestProperty("Content-Type", "application/json");
        JSONObject h = new JSONObject(cloudHeaders); for (java.util.Iterator<String> k = h.keys(); k.hasNext(); ) { String n = k.next(); c.setRequestProperty(n, h.getString(n)); }
        JSONObject body = new JSONObject().put("model", "canopylabs/orpheus-v1-english").put("voice", cloudVoice).put("input", text).put("response_format", "wav");
        try (java.io.OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes("UTF-8")); }
        int code = c.getResponseCode();
        if (code == 400 || code == 401 || code == 403) cloudPausedUntil = System.currentTimeMillis() + 10 * 60000;   // no point asking every sentence
        if (code != 200) throw new java.io.IOException("speech " + code);
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        try (java.io.InputStream in = c.getInputStream()) { byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) bo.write(b, 0, n); }
        float[][] w = Wav.decode(bo.toByteArray()); w[0] = Wav.trim(w[0], (int) w[1][0]); return w;
    }


    /** Pick the voice ("alan", "amy") or "" for the phone's own voice. Loads it in the background. */
    public void use(String name) {
        active = name == null ? "" : name;
        if (isReady(active)) queue.offer(new long[]{-1});                          // preload
    }

    public String status() {
        JSONObject o = new JSONObject();
        try {
            for (String v : new String[]{"alan", "amy"}) o.put(v, state.get(v));
            o.put("active", active);
            o.put("loaded", loaded);
        } catch (Exception ignored) { }
        return o.toString();
    }

    public void download(final String name) {
        if (VoicePack.packageFor(name) == null) return;
        String s = state.get(name);
        if (s != null && (s.startsWith("downloading") || "ready".equals(s))) { events.onStatus(status()); return; }
        state.put(name, "downloading:0");
        events.onStatus(status());
        downloads.execute(() -> {
            try {
                final int[] lastPct = {-1};
                VoicePack.download(root, name, (done, total) -> {
                    int pct = total > 0 ? (int) (done * 100 / total) : 0;
                    if (pct != lastPct[0]) { lastPct[0] = pct; state.put(name, "downloading:" + pct); events.onStatus(status()); }
                });
                state.put(name, "ready");
                if (name.equals(active)) queue.offer(new long[]{-1});
            } catch (Throwable e) {
                Log.w(TAG, "download " + name, e);
                state.put(name, "error:" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
            }
            events.onStatus(status());
        });
    }

    public void speak(long id, String text) {
        texts.put(id, text);
        if (cloudOn()) { final String t = text; fetched.put(id, fetcher.submit(() -> fetchCloud(t))); }
        queue.offer(new long[]{id});
    }

    /** Stop now: cut the current sentence and drop everything queued. */
    public void stop() {
        cancel = true;
        long[] j;
        while ((j = queue.poll()) != null) if (j[0] >= 0) { texts.remove(j[0]); fetched.remove(j[0]); events.onDone(j[0], true); }
        AudioTrack t = track;
        if (t != null) { try { t.pause(); t.flush(); } catch (Exception ignored) { } }
    }

    public void shutdown() {
        running = false;
        stop();
        worker.interrupt();
        downloads.shutdownNow();
    }

    // ------------------------------------------------------------------ worker
    private boolean ensureLoaded() {
        String want = active;
        if (!isReady(want)) return false;
        if (want.equals(loaded) && tts != null) return true;
        try {
            if (tts != null) { tts.release(); tts = null; loaded = ""; }
            File d = new File(root, want);
            OfflineTtsVitsModelConfig vits = new OfflineTtsVitsModelConfig();
            vits.setModel(new File(d, "model.onnx").getAbsolutePath());
            vits.setTokens(new File(d, "tokens.txt").getAbsolutePath());
            vits.setDataDir(new File(root, "espeak-ng-data").getAbsolutePath());
            OfflineTtsModelConfig mc = new OfflineTtsModelConfig();
            mc.setVits(vits);
            mc.setNumThreads(Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2)));
            mc.setProvider("cpu");
            OfflineTtsConfig cfg = new OfflineTtsConfig();
            cfg.setModel(mc);
            cfg.setMaxNumSentences(1);                                               // hand back one sentence at a time
            long t0 = System.currentTimeMillis();
            tts = new OfflineTts(null, cfg);
            loaded = want;
            Log.i(TAG, "loaded " + want + " in " + (System.currentTimeMillis() - t0) + " ms");
            events.onStatus(status());
            return true;
        } catch (Throwable e) {
            Log.e(TAG, "could not load " + want, e);
            state.put(want, "error:load failed");
            failed = want;
            VoicePack.deleteTree(new File(root, want));                              // a bad download: remove it so it can be fetched again
            events.onStatus(status());
            tts = null; loaded = "";
            return false;
        }
    }

    /** Receives each synthesised piece and plays it straight away. */
    private final class Sink implements kotlin.jvm.functions.Function1<float[], Integer> {
        long written = 0;
        public Integer invoke(float[] samples) {
            if (cancel) return 0;
            AudioTrack t = track;
            if (t != null && samples != null && samples.length > 0) {
                for (int s = 0; s < samples.length; s += HOP) {                  // record the loudness before playing it
                    double sum = 0; int e = Math.min(samples.length, s + HOP);
                    for (int k = s; k < e; k++) sum += samples[k] * samples[k];
                    float[] a = env; if (envLen >= a.length) { a = java.util.Arrays.copyOf(a, a.length * 2); env = a; }
                    a[envLen] = (float) Math.sqrt(sum / Math.max(1, e - s)); envLen++;
                }
                int off = 0;
                while (off < samples.length && !cancel) {
                    int w = t.write(samples, off, samples.length - off, AudioTrack.WRITE_BLOCKING);
                    if (w <= 0) break;
                    off += w;
                }
                written += off;
            }
            return cancel ? 0 : 1;
        }
    }

    private void loop() {
        while (running) {
            long[] job;
            try { job = queue.take(); } catch (InterruptedException e) { return; }
            if (job[0] < 0) { ensureLoaded(); continue; }
            long id = job[0];
            String text = texts.remove(id);
            if (text == null) continue;
            cancel = false;
            java.util.concurrent.Future<float[][]> f = fetched.remove(id);
            float[][] cloud = null;
            if (f != null) { try { cloud = f.get(25, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception e) { Log.w(TAG, "natural voice", e); } }
            if (cancel) { events.onDone(id, true); continue; }
            if (cloud == null && !ensureLoaded()) { if (f != null) events.onFallback(id, text); else events.onDone(id, false); continue; }
            boolean ok = true;
            try {
                int sr = cloud != null ? (int) cloud[1][0] : tts.sampleRate();
                if (track == null || track.getSampleRate() != sr) {
                    if (track != null) track.release();
                    int min = AudioTrack.getMinBufferSize(sr, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT);
                    track = new AudioTrack.Builder()
                            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                            .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(sr)
                                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                            .setTransferMode(AudioTrack.MODE_STREAM)
                            .setBufferSizeInBytes(Math.max(min, sr / 4 * 4))
                            .build();
                }
                track.play();
                final long base = track.getPlaybackHeadPosition() & 0xffffffffL;
                envLen = 0; envBase = base;
                Sink sink = new Sink();
                if (cloud != null) {                                                 // the natural voice: faster without going squeaky
                    try { track.setPlaybackParams(new android.media.PlaybackParams().setSpeed(speed).setPitch(1f)); } catch (Exception ignored) { }
                    sink.invoke(cloud[0]);
                } else {
                    try { track.setPlaybackParams(new android.media.PlaybackParams().setSpeed(1f).setPitch(1f)); } catch (Exception ignored) { }
                    tts.generateWithCallback(text, 0, PC_SPEED * speed, sink);
                }
                // wait for the speaker to finish what was written (the page waits for this "done" before listening again)
                long deadline = System.currentTimeMillis() + 2000 + sink.written * 1000L / sr;
                while (!cancel && System.currentTimeMillis() < deadline) {
                    long played = (track.getPlaybackHeadPosition() & 0xffffffffL) - base;
                    if (played >= sink.written) break;
                    Thread.sleep(15);
                }
                envLen = 0;
                if (cancel) { track.pause(); track.flush(); } else track.stop();
            } catch (Throwable e) {
                Log.w(TAG, "speak", e);
                ok = false;
            }
            events.onDone(id, ok);
        }
    }
}
