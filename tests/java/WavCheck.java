package com.jarvis.assistant;
// java check: Wav.decode reads 16-bit PCM WAVs, including the streamed kind with no data size
public class WavCheck {
    public static void main(String[] a) throws Exception {
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(44 + 8).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.putInt(0x46464952).putInt(0).putInt(0x45564157).putInt(0x20746d66).putInt(16).putShort((short) 1).putShort((short) 1).putInt(24000).putInt(48000).putShort((short) 2).putShort((short) 16)
         .putInt(0x61746164).putInt(-1).putShort((short) 16384).putShort((short) -32768).putShort((short) 0).putShort((short) 32767);
        float[][] w = Wav.decode(b.array());
        if (w[1][0] != 24000 || w[0].length != 4 || Math.abs(w[0][0] - 0.5f) > 1e-4 || w[0][1] != -1f || w[0][2] != 0f) throw new AssertionError(java.util.Arrays.toString(w[0]));
        float[] s = new float[24000]; for (int i = 9600; i < 14400; i++) s[i] = (float) Math.sin(i * 0.1) * 0.5f;   // 0.4 s quiet, 0.2 s voice, 0.4 s quiet
        float[] t = Wav.trim(s, 24000);
        if (t.length < 4800 || t.length > 4800 + 960 + 2160 + 480) throw new AssertionError("trim " + t.length);
        if (Wav.trim(new float[100], 24000).length > 100) throw new AssertionError("all quiet");
        System.out.println("wav check OK");
    }
}
