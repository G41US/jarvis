package com.jarvis.assistant;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** A WAV file (16-bit or float PCM) as mono float samples: {samples, {sampleRate}}. */
final class Wav {
    /** Cuts the silence the voice puts before and after each sentence (0.3-0.6 s, which between sentences sounded like halting),
     *  leaving a natural breath: 40 ms before, 90 ms after. */
    static float[] trim(float[] s, int rate) {
        int win = Math.max(1, rate / 100), a = 0, b = s.length;               // 10 ms windows
        while (a + win < b && rms(s, a, a + win) < 0.008f) a += win;
        while (b - win > a && rms(s, b - win, b) < 0.008f) b -= win;
        a = Math.max(0, a - rate * 40 / 1000); b = Math.min(s.length, b + rate * 90 / 1000);
        return a == 0 && b == s.length ? s : java.util.Arrays.copyOfRange(s, a, b);
    }
    private static float rms(float[] s, int a, int b) { double t = 0; for (int i = a; i < b; i++) t += s[i] * s[i]; return (float) Math.sqrt(t / Math.max(1, b - a)); }

    static float[][] decode(byte[] b) throws IOException {
        ByteBuffer bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
        if (b.length < 44 || bb.getInt(0) != 0x46464952 || bb.getInt(8) != 0x45564157) throw new IOException("not a wav");
        int fmt = 1, ch = 1, rate = 24000, bits = 16, p = 12;
        while (p + 8 <= b.length) {
            int id = bb.getInt(p), size = bb.getInt(p + 4), body = p + 8;
            if (id == 0x20746d66) { fmt = bb.getShort(body) & 0xffff; ch = bb.getShort(body + 2); rate = bb.getInt(body + 4); bits = bb.getShort(body + 14); }
            else if (id == 0x61746164) {                                 // "data": a streamed file may give 0 or -1 as its size
                int len = size <= 0 || body + size > b.length ? b.length - body : size, step = bits / 8 * ch, n = len / step;
                float[] out = new float[n];
                for (int i = 0; i < n; i++) {
                    int at = body + i * step;
                    out[i] = fmt == 3 && bits == 32 ? bb.getFloat(at) : bits == 16 ? bb.getShort(at) / 32768f : (b[at] & 0xff) / 128f - 1f;
                }
                return new float[][]{out, {rate}};
            }
            p = body + size + (size & 1);
        }
        throw new IOException("no audio in the wav");
    }
}
