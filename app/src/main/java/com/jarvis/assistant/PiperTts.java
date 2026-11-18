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
 * Jarvis's voices that play through the app itself: the natural voice online (Groq Orpheus), the natural voice on the phone
 * (Kokoro) and the PC voices (Piper "Alan" and "Amy"), all through sherpa-onnx or the Jarvis service. Every sentence is
 * prepared as soon as the reply is written (prefetch), so the next one is ready the moment the last one ends.
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
    /** A character's voice ("be Ultron"): deeper or higher without changing the speed. 1 is his own voice. */
    private volatile float pitch = 1f;
    public void setPitch(float p) { pitch = Math.max(0.6f, Math.min(1.6f, p)); }

    /** Loudness (RMS) of what the speaker is playing right now; 0 when quiet. */
    public float level() {
        AudioTrack t = track; int n = envLen; if (t == null || n == 0) return 0f;
        try { long i = ((t.getPlaybackHeadPosition() & 0xffffffffL) - envBase) / HOP; return i >= 0 && i < n ? env[(int) i] : 0f; }
        catch (Exception e) { return 0f; }
    }

    public PiperTts(File root, Events events) {
        this.root = root;
        this.events = events;
        for (String v : new String[]{"alan", "amy", "kokoro"}) state.put(v, VoicePack.isReady(root, v) ? "ready" : "missing");
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
    private final ConcurrentHashMap<String, java.util.concurrent.Future<float[][]>> ready = new ConcurrentHashMap<>();   // sentence -> its audio, being prepared
    private final ExecutorService synth = Executors.newSingleThreadExecutor();   // the only thread that touches the on-phone voice (tts)
    private volatile int kokoroSid = 6;                                          // which Kokoro speaker (6 Michael, 1 Bella, ...)
    private volatile long cloudPausedUntil = 0;                              // refused (terms not accepted, bad key): try again in a while
    private boolean cloudOn() { return fishOn() || (!cloudUrl.isEmpty() && !cloudVoice.isEmpty() && System.currentTimeMillis() > cloudPausedUntil); }
    // ---- a character's own voice ("be Ultron"): a voice from Fish Audio's library, spoken by Fish Audio with the user's key
    private volatile String fishKey = "", fishRef = "";
    private volatile long fishPausedUntil = 0;
    private boolean fishOn() { return !fishKey.isEmpty() && !fishRef.isEmpty() && System.currentTimeMillis() > fishPausedUntil; }
    public void setFish(String key, String ref) {
        String k = key == null ? "" : key.trim(), r = ref == null ? "" : ref.trim();
        if (!k.equals(fishKey) || !r.equals(fishRef)) { ready.clear(); fishPausedUntil = 0; }
        fishKey = k; fishRef = r;
    }
    private float[][] fetchFish(String text) throws Exception {
        String said = SpokenText.offline(text);                                   // no "[warm]" read out
        if (said.isEmpty()) return new float[][]{new float[0], {24000, 0}};
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("https://api.fish.audio/v1/tts").openConnection();
        c.setRequestMethod("POST"); c.setDoOutput(true); c.setConnectTimeout(8000); c.setReadTimeout(25000);
        c.setRequestProperty("Content-Type", "application/json"); c.setRequestProperty("Authorization", "Bearer " + fishKey);
        c.setRequestProperty("model", "s2.1-pro-free");
        JSONObject body = new JSONObject().put("text", said).put("reference_id", fishRef).put("format", "wav").put("sample_rate", 24000).put("latency", "balanced");
        try (java.io.OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes("UTF-8")); }
        int code = c.getResponseCode();
        if (code != 200) {
            String err = ""; try (java.io.InputStream es = c.getErrorStream()) { if (es != null) { byte[] eb = new byte[2048]; int n = es.read(eb); if (n > 0) err = new String(eb, 0, n, "UTF-8"); } } catch (Exception ignored) { }
            // 401 wrong key, 402 no free use left, 429 too many: Jarvis's own voice for a while, then try again
            if (code == 401 || code == 402 || code == 403 || code == 429) { fishPausedUntil = System.currentTimeMillis() + (code == 429 ? 2 : 10) * 60000; cloudNote = code == 402 ? "fish-credits" : code == 429 ? "fish-busy" : "fish-key"; }
            throw new java.io.IOException("fish " + code + " " + err);
        }
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        try (java.io.InputStream in = c.getInputStream()) { byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) bo.write(b, 0, n); }
        float[][] w = Wav.decode(bo.toByteArray()); w[0] = Wav.trim(w[0], (int) w[1][0]); return new float[][]{w[0], {w[1][0], 1}};
    }
    public void setCloud(String url, String headersJson, String voice) {
        cloudUrl = url == null ? "" : url; cloudHeaders = headersJson == null ? "{}" : headersJson; cloudVoice = voice == null ? "" : voice;
    }

    private volatile String cloudNote = "ok";                                   // for Settings: ok, quota:<minutes>, refused
    public String cloudStatus() { return cloudOn() ? "ok" : cloudUrl.isEmpty() ? "off" : cloudNote; }

    /** A sentence from the natural voice: {samples, {sampleRate}}. Groq takes up to 200 characters a request, so a long
     *  sentence goes in pieces cut at commas or spaces, joined back together. */
    private float[][] fetchCloud(String text) throws Exception {
        if (fishOn()) return fetchFish(text);
        java.util.List<String> parts = new java.util.ArrayList<>();
        String rest = text.trim();
        while (rest.length() > 190) {
            int cut = Math.max(rest.lastIndexOf(", ", 190), rest.lastIndexOf("; ", 190));
            if (cut < 60) cut = rest.lastIndexOf(' ', 190); if (cut < 1) cut = 190;
            parts.add(rest.substring(0, cut + 1).trim()); rest = rest.substring(cut + 1).trim();
        }
        if (!rest.isEmpty()) parts.add(rest);
        float[] all = new float[0]; float rate = 24000;
        for (String p : parts) {
            float[][] w = fetchOne(p); rate = w[1][0];
            float[] joined = java.util.Arrays.copyOf(all, all.length + w[0].length); System.arraycopy(w[0], 0, joined, all.length, w[0].length); all = joined;
        }
        return new float[][]{all, {rate, 1}};                                  // 1: from the cloud (speed is applied when playing)
    }

    private float[][] fetchOne(String text) throws Exception {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(cloudUrl).openConnection();
        c.setRequestMethod("POST"); c.setDoOutput(true); c.setConnectTimeout(8000); c.setReadTimeout(20000);
        c.setRequestProperty("Content-Type", "application/json");
        JSONObject h = new JSONObject(cloudHeaders); for (java.util.Iterator<String> k = h.keys(); k.hasNext(); ) { String n = k.next(); c.setRequestProperty(n, h.getString(n)); }
        JSONObject body = new JSONObject().put("model", "canopylabs/orpheus-v1-english").put("voice", cloudVoice).put("input", SpokenText.cloud(text)).put("response_format", "wav");
        try (java.io.OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes("UTF-8")); }
        int code = c.getResponseCode();
        if (code != 200) {
            String err = ""; try (java.io.InputStream es = c.getErrorStream()) { if (es != null) { byte[] eb = new byte[2048]; int n = es.read(eb); if (n > 0) err = new String(eb, 0, n, "UTF-8"); } } catch (Exception ignored) { }
            if (code == 429) {                                                    // the day's free allowance is used up: wait until Groq says it resets
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("try again in (?:(\\d+)h)?(?:(\\d+)m)?").matcher(err);
                long mins = m.find() ? (m.group(1) == null ? 0 : Long.parseLong(m.group(1)) * 60) + (m.group(2) == null ? 1 : Long.parseLong(m.group(2)) + 1) : 15;
                cloudPausedUntil = System.currentTimeMillis() + mins * 60000; cloudNote = "quota:" + mins;
            } else if (code == 401 || code == 403 || err.contains("terms")) { cloudPausedUntil = System.currentTimeMillis() + 10 * 60000; cloudNote = "refused"; }
            throw new java.io.IOException("speech " + code + " " + err);
        }
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        try (java.io.InputStream in = c.getInputStream()) { byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) bo.write(b, 0, n); }
        float[][] w = Wav.decode(bo.toByteArray()); w[0] = Wav.trim(w[0], (int) w[1][0]); return w;
    }


    /** Pick the voice ("alan", "amy", "kokoro:6") or "" for the phone's own voice. Loads it in the background. */
    public void use(String name) {
        String n = name == null ? "" : name;
        if (n.startsWith("kokoro:")) { try { kokoroSid = Integer.parseInt(n.substring(7)); } catch (Exception ignored) { } n = "kokoro"; }
        if (!n.equals(active)) ready.clear();
        active = n;
        if (isReady(active)) synth.execute(this::ensureLoaded);                    // preload
    }

    /** The on-phone voice, one whole sentence: {samples, {rate, 0}}. */
    private float[][] synthLocal(String text) throws Exception {
        if (!ensureLoaded()) throw new java.io.IOException("no voice on the phone");
        boolean kok = "kokoro".equals(loaded);
        String said = SpokenText.offline(text);                                      // "Hmm", not "H-M"; no "[warm]" read out
        if (said.isEmpty()) return new float[][]{new float[0], {24000, 0}};
        com.k2fsa.sherpa.onnx.GeneratedAudio a = tts.generate(said, kok ? kokoroSid : 0, kok ? speed : PC_SPEED * speed);
        return new float[][]{Wav.trim(a.getSamples(), a.getSampleRate()), {a.getSampleRate(), 0}};
    }

    /** Starts preparing a sentence now (the page sends each one the moment the reply is written), so it plays without a gap. */
    public void prefetch(final String text) {
        if (text == null || text.trim().isEmpty() || ready.containsKey(text)) return;
        final boolean local = isReady(active) && !active.equals(failed);
        if (cloudOn()) ready.put(text, fetcher.submit(() -> {
            try { return fetchCloud(text); }
            catch (Exception e) { if (local) return synth.submit(() -> synthLocal(text)).get(); throw e; }   // offline or out of allowance
        }));
        else if (local) ready.put(text, synth.submit(() -> synthLocal(text)));
    }

    public String status() {
        JSONObject o = new JSONObject();
        try {
            for (String v : new String[]{"alan", "amy", "kokoro"}) o.put(v, state.get(v));
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
                if (name.equals(active)) synth.execute(this::ensureLoaded);
            } catch (Throwable e) {
                Log.w(TAG, "download " + name, e);
                state.put(name, "error:" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
            }
            events.onStatus(status());
        });
    }

    public void speak(long id, String text) {
        texts.put(id, text);
        prefetch(text);
        queue.offer(new long[]{id});
    }

    /** Stop now: cut the current sentence and drop everything queued. */
    public void stop() {
        cancel = true;
        long[] j;
        while ((j = queue.poll()) != null) if (j[0] >= 0) { texts.remove(j[0]); events.onDone(j[0], true); }
        ready.clear();
        AudioTrack t = track;
        if (t != null) { try { t.pause(); t.flush(); } catch (Exception ignored) { } }
    }

    public void shutdown() {
        running = false;
        stop();
        worker.interrupt();
        downloads.shutdownNow(); synth.shutdownNow(); fetcher.shutdownNow();
    }

    // ------------------------------------------------------------------ worker
    private boolean ensureLoaded() {
        String want = active;
        if (!isReady(want)) return false;
        if (want.equals(loaded) && tts != null) return true;
        try {
            if (tts != null) { tts.release(); tts = null; loaded = ""; }
            File d = new File(root, want);
            OfflineTtsModelConfig mc = new OfflineTtsModelConfig();
            if ("kokoro".equals(want)) {
                com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig k = new com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig();
                k.setModel(new File(d, "model.onnx").getAbsolutePath()); k.setVoices(new File(d, "voices.bin").getAbsolutePath());
                k.setTokens(new File(d, "tokens.txt").getAbsolutePath()); k.setDataDir(new File(root, "espeak-ng-data").getAbsolutePath());
                mc.setKokoro(k);
            } else {
                OfflineTtsVitsModelConfig vits = new OfflineTtsVitsModelConfig();
                vits.setModel(new File(d, "model.onnx").getAbsolutePath());
                vits.setTokens(new File(d, "tokens.txt").getAbsolutePath());
                vits.setDataDir(new File(root, "espeak-ng-data").getAbsolutePath());
                mc.setVits(vits);
            }
            mc.setNumThreads(Math.max(1, Math.min("kokoro".equals(want) ? 6 : 4, Runtime.getRuntime().availableProcessors() - 2)));   // Kokoro is heavier: more of the phone's cores
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
            if (job[0] < 0) continue;
            long id = job[0];
            String text = texts.remove(id);
            if (text == null) continue;
            cancel = false;
            java.util.concurrent.Future<float[][]> f = ready.remove(text);
            if (f == null) { prefetch(text); f = ready.remove(text); }
            float[][] audio = null;
            if (f != null) { try { audio = f.get(30, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception e) { Log.w(TAG, "voice", e); } }
            if (cancel) { events.onDone(id, true); continue; }
            if (audio == null || audio[0].length == 0) { events.onFallback(id, text); continue; }   // the phone's own voice says it
            boolean ok = true;
            try {
                int sr = (int) audio[1][0];
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
                float play = audio[1].length > 1 && audio[1][1] == 1 ? speed : 1f;   // the cloud voice is sped up while playing, without going squeaky
                try { track.setPlaybackParams(new android.media.PlaybackParams().setSpeed(play).setPitch(pitch)); } catch (Exception ignored) { }
                sink.invoke(audio[0]);
                // wait for the speaker to finish what was written (the page waits for this "done" before listening again)
                long deadline = System.currentTimeMillis() + 2000 + (long) (sink.written * 1000.0 / sr / Math.min(1f, play));   // slowed down plays longer
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
