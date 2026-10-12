package com.jarvis.assistant;

/**
 * Speech detector: Silero VAD (MIT licence), the same streaming steps as its official Python wrapper.
 * Tells "someone is talking" from "it's just noise" (engine, fan, traffic), which a loudness threshold can't do
 * on a raw phone microphone. Feed it any chunk size; it works in 512-sample frames with 64 samples of context.
 */
public final class SileroVad {
    /** One model call: input [1, 576] and state [2, 1, 128] in; [probability, new state x256] out. */
    public interface Net { float[] run(float[] input, float[] state) throws Exception; }

    static final int FRAME = 512, CONTEXT = 64, STATE = 2 * 128;
    private final Net net;
    private final float[] state = new float[STATE];
    private final float[] context = new float[CONTEXT];
    private final float[] pending = new float[FRAME];
    private int pendingLen = 0;
    private float last = 0f;

    public SileroVad(Net net) { this.net = net; }

    /** Feeds a chunk; returns the highest speech probability of the frames it completed (or the previous value). */
    public float process(short[] chunk) throws Exception {
        float best = -1f;
        for (short v : chunk) {
            pending[pendingLen++] = v / 32768f;
            if (pendingLen == FRAME) {
                float[] in = new float[CONTEXT + FRAME];
                System.arraycopy(context, 0, in, 0, CONTEXT);
                System.arraycopy(pending, 0, in, CONTEXT, FRAME);
                float[] out = net.run(in, state);
                System.arraycopy(out, 1, state, 0, STATE);
                System.arraycopy(in, in.length - CONTEXT, context, 0, CONTEXT);
                pendingLen = 0;
                best = Math.max(best, out[0]);
            }
        }
        if (best >= 0f) last = best;
        return last;
    }
}
