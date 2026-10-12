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
        void onLevel(float rms, float score);
        void onPcm(short[] pcm);
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
    private String wakeError = "";
    private final ArrayDeque<short[]> preroll = new ArrayDeque<>();

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
    public String wakeError() { return wakeError; }

    /** Page says whether Jarvis is listening to the user right now (session open, not talking). */
    public void setListening(boolean on) {
        synchronized (preroll) {
            if (on && !listening) { for (short[] c : preroll) out.onPcm(c); preroll.clear(); }
            listening = on;
        }
    }
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
            rec.startRecording();
            out.onState(wake != null ? "listening" : "listening-no-wake:" + wakeError);

            WakeWord.AutoGain gain = new WakeWord.AutoGain(6f);
            short[] buf = new short[CHUNK];
            long lastWake = 0;
            int n = 0;
            float peakScore = 0f;
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

                synchronized (preroll) {
                    if (listening && !muted) out.onPcm(chunk);
                    else { preroll.add(chunk); while (preroll.size() > PREROLL_CHUNKS) preroll.removeFirst(); }
                }

                if (++n % 2 == 0) { out.onLevel(rms, peakScore); peakScore = 0f; }
            }
        } catch (Throwable e) {
            Log.e(TAG, "mic loop stopped", e);
            out.onState("error:" + e.getMessage());
        } finally {
            if (rec != null) { try { rec.stop(); } catch (Exception ignored) { } rec.release(); }
            running = false;
            out.onState("stopped");
        }
    }
}
