import com.jarvis.assistant.SileroVad;
import java.io.File;
import java.util.Locale;
import java.util.Scanner;

/** Replays the official Silero streaming run: checks SileroVad.java sends identical inputs/state and gets identical probabilities. */
public class SileroVadTest {
    public static void main(String[] a) throws Exception {
        Scanner sc = new Scanner(new File(a[0])).useLocale(Locale.ROOT);
        int nc = sc.nextInt(); short[][] chunks = new short[nc][1280];
        for (int i = 0; i < nc; i++) for (int j = 0; j < 1280; j++) chunks[i][j] = (short) sc.nextInt();
        int calls = sc.nextInt(); final double[] inSum = new double[calls], stSum = new double[calls]; final float[][] out = new float[calls][];
        for (int i = 0; i < calls; i++) { inSum[i] = sc.nextDouble(); stSum[i] = sc.nextDouble(); int k = sc.nextInt(); out[i] = new float[k]; for (int j = 0; j < k; j++) out[i][j] = (float) sc.nextDouble(); }
        double[] want = new double[nc]; for (int i = 0; i < nc; i++) want[i] = sc.nextDouble();
        final int[] pos = {0};
        SileroVad vad = new SileroVad((input, state) -> {
            int i = pos[0]++;
            if (input.length != 576 || state.length != 256) throw new AssertionError("shape " + input.length + "/" + state.length);
            double s = 0, t = 0; for (float v : input) s += v; for (float v : state) t += v;
            if (Math.abs(s - inSum[i]) > 1e-3 || Math.abs(t - stSum[i]) > 1e-3) throw new AssertionError("frame " + i + ": input/state differ (" + s + " vs " + inSum[i] + ", " + t + " vs " + stSum[i] + ")");
            return out[i];
        });
        double worst = 0;
        for (int i = 0; i < nc; i++) worst = Math.max(worst, Math.abs(vad.process(chunks[i]) - want[i]));
        System.out.println("replayed " + pos[0] + "/" + calls + " frames; worst probability difference " + worst);
        boolean ok = pos[0] == calls && worst < 1e-6;
        System.out.println(ok ? "PASS" : "FAIL"); System.exit(ok ? 0 : 1);
    }
}
