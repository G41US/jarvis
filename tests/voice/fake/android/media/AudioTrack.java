package android.media;
/** Test speaker: accepts audio and "plays" it at real-time speed, like the phone's speaker would. */
public class AudioTrack {
    public static final int MODE_STATIC = 0, MODE_STREAM = 1, WRITE_BLOCKING = 0;
    public static long totalPlayedMs = 0;
    private final int sr = 22050; private long written = 0, startNs = 0; private boolean playing = false; private long base = 0;
    public int write(short[] d, int off, int n) { return n; }
    public int write(float[] d, int off, int n, int mode) { written += n; return n; }
    public void play() { playing = true; startNs = System.nanoTime(); base = written; }
    public void pause() { playing = false; } public void flush() { written = base; } public void stop() { totalPlayedMs += (written - base) * 1000 / sr; playing = false; }
    public void release() {}
    public int getSampleRate() { return sr; }
    public int getPlaybackHeadPosition() { if (!playing) return (int) written; long played = (System.nanoTime() - startNs) / 1_000_000L * sr / 1000; return (int) Math.min(written, base + played); }
    public static int getMinBufferSize(int r, int c, int f) { return 4096; }
    public static class Builder { public Builder setAudioAttributes(AudioAttributes a){return this;} public Builder setAudioFormat(AudioFormat f){return this;} public Builder setTransferMode(int m){return this;} public Builder setBufferSizeInBytes(int n){return this;} public AudioTrack build(){return new AudioTrack();} }
}
