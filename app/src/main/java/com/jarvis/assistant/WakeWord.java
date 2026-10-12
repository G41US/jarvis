package com.jarvis.assistant;

import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.Random;

/**
 * "Hey Jarvis" detector: the same openWakeWord models and streaming steps the PC version (wake.py) uses.
 * Feed it 80 ms chunks (1280 samples, 16 kHz, 16-bit). Each chunk returns a score from 0 to 1.
 *
 * Pipeline per chunk (mirrors openwakeword.utils.AudioFeatures._streaming_features):
 *   last 1280+480 samples -> melspectrogram model -> (x/10 + 2) -> mel frame buffer (76 x 32)
 *   last 76 mel frames -> embedding model -> one 96-number feature
 *   last 16 features -> hey_jarvis model -> score
 */
public final class WakeWord {
    /** One ONNX model: flat float input with a shape, flat float output. */
    public interface Net { float[] run(float[] input, long[] shape) throws Exception; }

    public static final int CHUNK = 1280;
    static final int MEL_CTX = CHUNK + 160 * 3, BINS = 32, WIN = 76, EMB = 96, FEATS = 16;

    private final Net mel, emb, cls;
    private final short[] raw = new short[MEL_CTX];
    private int rawLen = 0;
    private final ArrayDeque<float[]> melBuf = new ArrayDeque<>();
    private final ArrayDeque<float[]> featBuf = new ArrayDeque<>();
    private int predictions = 0;

    public WakeWord(Net mel, Net emb, Net cls, float[][] initialFeatures) throws Exception {
        this.mel = mel; this.emb = emb; this.cls = cls;
        for (int i = 0; i < WIN; i++) { float[] r = new float[BINS]; java.util.Arrays.fill(r, 1f); melBuf.add(r); }
        float[][] init = initialFeatures != null ? initialFeatures : noiseFeatures();
        for (float[] f : init) pushFeature(f);
    }

    /** Like openWakeWord's start-up: features of 4 s of quiet noise, so the first second never fires. */
    private float[][] noiseFeatures() throws Exception {
        Random rnd = new Random(7);
        int n = 16000 * 4;
        float[] x = new float[n];
        for (int i = 0; i < n; i++) x[i] = rnd.nextInt(2000) - 1000;
        float[] m = mel.run(x, new long[]{1, n});
        int frames = m.length / BINS;
        java.util.List<float[]> out = new java.util.ArrayList<>();
        for (int start = 0; start + WIN <= frames; start += 8) {
            float[] in = new float[WIN * BINS];
            for (int t = 0; t < WIN; t++) for (int b = 0; b < BINS; b++) in[t * BINS + b] = m[(start + t) * BINS + b] / 10f + 2f;
            out.add(emb.run(in, new long[]{1, WIN, BINS, 1}));
        }
        return out.toArray(new float[0][]);
    }

    private void pushFeature(float[] f) {
        float[] c = new float[EMB];
        System.arraycopy(f, 0, c, 0, Math.min(EMB, f.length));
        featBuf.add(c);
        while (featBuf.size() > FEATS) featBuf.removeFirst();
    }

    /** One 80 ms chunk in, wake score out (0..1). */
    public float process(short[] chunk) throws Exception {
        if (chunk.length != CHUNK) throw new IllegalArgumentException("chunk must be " + CHUNK + " samples");
        // keep the newest MEL_CTX samples
        if (rawLen + CHUNK <= MEL_CTX) { System.arraycopy(chunk, 0, raw, rawLen, CHUNK); rawLen += CHUNK; }
        else {
            int keep = MEL_CTX - CHUNK;
            System.arraycopy(raw, rawLen - keep, raw, 0, keep);
            System.arraycopy(chunk, 0, raw, keep, CHUNK);
            rawLen = MEL_CTX;
        }
        float[] x = new float[rawLen];
        for (int i = 0; i < rawLen; i++) x[i] = raw[i];
        float[] m = mel.run(x, new long[]{1, rawLen});
        for (int t = 0; t + BINS <= m.length; t += BINS) {
            float[] row = new float[BINS];
            for (int b = 0; b < BINS; b++) row[b] = m[t + b] / 10f + 2f;
            melBuf.add(row);
        }
        while (melBuf.size() > WIN) melBuf.removeFirst();

        float[] in = new float[WIN * BINS];
        int r = 0;
        for (float[] row : melBuf) { System.arraycopy(row, 0, in, r * BINS, BINS); r++; }
        pushFeature(emb.run(in, new long[]{1, WIN, BINS, 1}));

        float[] f = new float[FEATS * EMB];
        int k = 0;
        for (Iterator<float[]> it = featBuf.iterator(); it.hasNext(); k++) System.arraycopy(it.next(), 0, f, k * EMB, EMB);
        float score = cls.run(f, new long[]{1, FEATS, EMB})[0];
        predictions++;
        return predictions <= 5 ? 0f : score;           // openWakeWord ignores the first five predictions
    }

    /** wake.py's auto-gain: lift a quiet voice toward a healthy level; leave room noise alone. */
    public static final class AutoGain {
        private float peak = 0f;
        private final float max;
        public AutoGain(float max) { this.max = max; }
        public short[] apply(short[] x) {
            float p = 0f;
            for (short s : x) p = Math.max(p, Math.abs((float) s));
            peak = Math.max(p, peak * 0.97f);
            if (max > 1f && peak > 250f && peak < 5000f) {
                float g = Math.min(max, 6000f / peak);
                short[] y = new short[x.length];
                for (int i = 0; i < x.length; i++) y[i] = (short) Math.max(-32768f, Math.min(32767f, x[i] * g));   // numpy: clip then truncate
                return y;
            }
            return x;
        }
    }
}
