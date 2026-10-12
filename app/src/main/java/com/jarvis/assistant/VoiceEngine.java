package com.jarvis.assistant;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.SystemClock;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.ArrayDeque;
import java.util.Collections;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * The phone's ears. Records the microphone natively (no browser in the way), listens for "Hey Jarvis" on the phone itself,
 * and only passes audio to the page while Jarvis is actually listening to you. Idle audio never leaves the phone.
 */
public final class VoiceEngine implements Runnable {
    public interface Listener {
        void onWake(float score);
        void onLevel(float rms, float score, float speech);
        void onPcm(short[] pcm, float speech);
        void onState(String state);
    }

    private static final String TAG = "JarvisVoice";
    private static final int RATE = 16000, CHUNK = WakeWord.CHUNK;
    private static final int PREROLL_CHUNKS = 15;            // 1.2 s of audio from just before the wake word

    private final Context ctx;
    private final Listener out;
    private volatile boolean running = false, listening = false, speaking = false, muted = false;
    private volatile float threshold = 0.3f, speakingThreshold = 0.5f;   // same trigger as wake.py; stricter over Jarvis's own voice
    private Thread thread;
    private WakeWord wake;
    private SileroVad vad;                                   // speech probability per chunk (-1 when the model is missing)
    private android.media.audiofx.AcousticEchoCanceler aec;     // removes Jarvis's own voice from the mic where the phone supports it
    private String wakeError = "";
    private final ArrayDeque<short[]> preroll = new ArrayDeque<>();
    private final ArrayDeque<Float> prerollSpeech = new ArrayDeque<>();

    public VoiceEngine(Context ctx, Listener out) { this.ctx = ctx.getApplicationContext(); this.out = out; }

    public synchronized void start() {
        if (running) return;
        running = true;
        thread = new Thread(this, "jarvis-mic");
        thread.setPriority(Thread.MAX_PRIORITY);
        thread.start();
    }

    public synchronized void stop() { running = false; if (thread != null) thread.interrupt(); thread = null; }
    public boolean isRunning() { return running; }
    public boolean hasWakeWord() { return wake != null; }
    public boolean hasVad() { return vad != null; }
    public String wakeError() { return wakeError; }

    /** Page says whether Jarvis is listening to the user right now (session open, not talking).
     *  withPreroll: also send the second of audio from just before - ONLY right after "Hey Jarvis", so a command said in the
     *  same breath isn't clipped. Never after Jarvis has been talking: that second would be his own voice. */
    public void setListening(boolean on, boolean withPreroll) {
        synchronized (preroll) {
            if (on && !listening && withPreroll) {
                java.util.Iterator<Float> sp = prerollSpeech.iterator();
                for (short[] c : preroll) out.onPcm(c, sp.hasNext() ? sp.next() : -1f);
            }
            if (on != listening) { preroll.clear(); prerollSpeech.clear(); }
            listening = on;
        }
    }
    public void setListening(boolean on) { setListening(on, false); }
    public void setSpeaking(boolean on) { speaking = on; }
    public void setMuted(boolean on) { muted = on; }
    public void setThreshold(float t) { if (t > 0.05f && t < 0.95f) { threshold = t; speakingThreshold = Math.max(t, Math.min(0.9f, t + 0.2f)); } }

    // ------------------------------------------------------------------ models
    private static byte[] asset(Context c, String name) throws Exception {
        InputStream in = c.getAssets().open(name);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[65536];
        int n;
        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        in.close();
        return bo.toByteArray();
    }

    private static WakeWord.Net onnx(final OrtEnvironment env, byte[] model) throws Exception {
        OrtSession.SessionOptions o = new OrtSession.SessionOptions();
        o.setIntraOpNumThreads(1);
        o.setInterOpNumThreads(1);
        final OrtSession s = env.createSession(model, o);
        final String input = s.getInputNames().iterator().next();
        return new WakeWord.Net() {
            @Override public float[] run(float[] data, long[] shape) throws Exception {
                OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(data), shape);
                try {
                    OrtSession.Result r = s.run(Collections.singletonMap(input, t));
                    try {
                        FloatBuffer fb = ((OnnxTensor) r.get(0)).getFloatBuffer();
                        float[] res = new float[fb.remaining()];
                        fb.get(res);
                        return res;
                    } finally { r.close(); }
                } finally { t.close(); }
            }
        };
    }

    private static SileroVad.Net silero(final OrtEnvironment env, byte[] model) throws Exception {
        OrtSession.SessionOptions o = new OrtSession.SessionOptions();
        o.setIntraOpNumThreads(1);
        o.setInterOpNumThreads(1);
        final OrtSession s = env.createSession(model, o);
        final OnnxTensor sr = OnnxTensor.createTensor(env, java.nio.LongBuffer.wrap(new long[]{16000}), new long[]{});
        return new SileroVad.Net() {
            @Override public float[] run(float[] input, float[] state) throws Exception {
                OnnxTensor x = OnnxTensor.createTensor(env, FloatBuffer.wrap(input), new long[]{1, input.length});
                OnnxTensor st = OnnxTensor.createTensor(env, FloatBuffer.wrap(state), new long[]{2, 1, 128});
                try {
                    java.util.Map<String, OnnxTensor> in = new java.util.HashMap<>();
                    in.put("input", x); in.put("state", st); in.put("sr", sr);
                    OrtSession.Result r = s.run(in);
                    try {
                        FloatBuffer p = ((OnnxTensor) r.get(0)).getFloatBuffer(), ns = ((OnnxTensor) r.get(1)).getFloatBuffer();
                        float[] res = new float[1 + ns.remaining()];
                        res[0] = p.get(0);
                        ns.get(res, 1, res.length - 1);
                        return res;
                    } finally { r.close(); }
                } finally { x.close(); st.close(); }
            }
        };
    }

    private void loadVad() {
        try { vad = new SileroVad(silero(OrtEnvironment.getEnvironment(), asset(ctx, "vad/silero_vad.onnx"))); }
        catch (Throwable e) { vad = null; Log.e(TAG, "speech detector failed to load", e); }
    }

    private void loadWake() {
        try {
            OrtEnvironment env = OrtEnvironment.getEnvironment();
            wake = new WakeWord(onnx(env, asset(ctx, "wake/melspectrogram.onnx")), onnx(env, asset(ctx, "wake/embedding_model.onnx")),
                    onnx(env, asset(ctx, "wake/hey_jarvis.onnx")), null);
        } catch (Throwable e) {
            wake = null;
            wakeError = String.valueOf(e);
            Log.e(TAG, "wake word model failed to load", e);
        }
    }

    // ------------------------------------------------------------------ recording loop
    @Override public void run() {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
        loadWake();
        loadVad();
        AudioRecord rec = null;
        try {
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int size = Math.max(min, CHUNK * 2 * 8);
            int[] sources = {MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC};
            for (int src : sources) {
                try {
                    rec = new AudioRecord(src, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size);
                    if (rec.getState() == AudioRecord.STATE_INITIALIZED) break;
                    rec.release();
                    rec = null;
                } catch (Exception e) { rec = null; }
            }
            if (rec == null) { out.onState("error:microphone unavailable"); running = false; return; }
            try {
                if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) {
                    aec = android.media.audiofx.AcousticEchoCanceler.create(rec.getAudioSessionId());
                    if (aec != null) aec.setEnabled(true);
                }
            } catch (Exception e) { Log.w(TAG, "echo canceller unavailable", e); }
            rec.startRecording();
            out.onState(wake != null ? "listening" : "listening-no-wake:" + wakeError);

            WakeWord.AutoGain gain = new WakeWord.AutoGain(6f);
            short[] buf = new short[CHUNK];
            long lastWake = 0;
            int n = 0;
            float peakScore = 0f, peakSpeech = -1f;
            while (running) {
                int got = 0;
                while (got < CHUNK && running) {
                    int r = rec.read(buf, got, CHUNK - got);
                    if (r < 0) throw new IllegalStateException("AudioRecord.read " + r);
                    got += r;
                }
                if (!running) break;
                short[] chunk = buf.clone();

                double s = 0;
                for (short v : chunk) s += (double) v * v;
                float rms = (float) Math.sqrt(s / CHUNK);

                float score = 0f;
                if (wake != null && !muted) {
                    try { score = wake.process(gain.apply(chunk)); } catch (Exception e) { Log.w(TAG, "wake", e); }
                    long now = SystemClock.elapsedRealtime();
                    if (score >= (speaking ? speakingThreshold : threshold) && now - lastWake > 2000) {
                        lastWake = now;
                        out.onWake(score);
                    }
                }
                peakScore = Math.max(peakScore, score);

                float speech = -1f;
                if (vad != null) { try { speech = vad.process(chunk); } catch (Exception e) { Log.w(TAG, "vad", e); } }
                peakSpeech = Math.max(peakSpeech, speech);

                synchronized (preroll) {
                    if (listening && !muted) out.onPcm(chunk, speech);
                    else {
                        preroll.add(chunk); prerollSpeech.add(speech);
                        while (preroll.size() > PREROLL_CHUNKS) { preroll.removeFirst(); prerollSpeech.removeFirst(); }
                    }
                }

                if (++n % 2 == 0) { out.onLevel(rms, peakScore, peakSpeech); peakScore = 0f; peakSpeech = -1f; }
            }
        } catch (Throwable e) {
            Log.e(TAG, "mic loop stopped", e);
            out.onState("error:" + e.getMessage());
        } finally {
            if (aec != null) { try { aec.release(); } catch (Exception ignored) { } aec = null; }
            if (rec != null) { try { rec.stop(); } catch (Exception ignored) { } rec.release(); }
            running = false;
            out.onState("stopped");
        }
    }
}
