package com.jarvis.assistant;
// java check: Wav.decode reads 16-bit PCM WAVs, including the streamed kind with no data size
public class WavCheck {
    public static void main(String[] a) throws Exception {
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(44 + 8).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.putInt(0x46464952).putInt(0).putInt(0x45564157).putInt(0x20746d66).putInt(16).putShort((short) 1).putShort((short) 1).putInt(24000).putInt(48000).putShort((short) 2).putShort((short) 16)
         .putInt(0x61746164).putInt(-1).putShort((short) 16384).putShort((short) -32768).putShort((short) 0).putShort((short) 32767);
        float[][] w = Wav.decode(b.array());
        if (w[1][0] != 24000 || w[0].length != 4 || Math.abs(w[0][0] - 0.5f) > 1e-4 || w[0][1] != -1f || w[0][2] != 0f) throw new AssertionError(java.util.Arrays.toString(w[0]));
        System.out.println("wav check OK");
    }
}
