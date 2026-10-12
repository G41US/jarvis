import com.jarvis.assistant.WakeWord;
import java.io.File;
import java.util.Locale;
import java.util.Scanner;

/** Replays the model calls recorded from the official openWakeWord run and checks WakeWord.java feeds the models
 *  exactly the same inputs and produces the same scores. */
public class WakeWordTest {
    static String[] mdl; static int[] n; static double[] sum, first, last; static float[][] out; static int pos = 0, fails = 0;

    static WakeWord.Net net(final String tag) {
        return (input, shape) -> {
            int i = pos++;
            if (!mdl[i].equals(tag)) throw new AssertionError("call " + i + ": expected model " + mdl[i] + " got " + tag);
            long count = 1; for (long s : shape) count *= s;
            if (input.length != n[i] || count != n[i]) throw new AssertionError("call " + i + " (" + tag + "): size " + input.length + " shape " + count + " expected " + n[i]);
            double s = 0; for (float v : input) s += v;
            if (Math.abs(s - sum[i]) > 1e-3 * Math.max(1, Math.abs(sum[i])) || Math.abs(input[0] - first[i]) > 1e-5 || Math.abs(input[input.length - 1] - last[i]) > 1e-5)
                throw new AssertionError("call " + i + " (" + tag + "): input differs (sum " + s + " vs " + sum[i] + ")");
            return out[i];
        };
    }

    public static void main(String[] a) throws Exception {
        Scanner sc = new Scanner(new File(a[0])).useLocale(Locale.ROOT);
        int fr = sc.nextInt(), fd = sc.nextInt(); float[][] init = new float[fr][fd];
        for (int i = 0; i < fr; i++) for (int j = 0; j < fd; j++) init[i][j] = (float) sc.nextDouble();
        int nc = sc.nextInt(); short[][] chunks = new short[nc][1280];
        for (int i = 0; i < nc; i++) for (int j = 0; j < 1280; j++) chunks[i][j] = (short) sc.nextInt();
        int calls = sc.nextInt(); mdl = new String[calls]; n = new int[calls]; sum = new double[calls]; first = new double[calls]; last = new double[calls]; out = new float[calls][];
        for (int i = 0; i < calls; i++) {
            mdl[i] = sc.next(); n[i] = sc.nextInt(); sum[i] = sc.nextDouble(); first[i] = sc.nextDouble(); last[i] = sc.nextDouble();
            int k = sc.nextInt(); out[i] = new float[k]; for (int j = 0; j < k; j++) out[i][j] = (float) sc.nextDouble();
        }
        double[] want = new double[nc]; for (int i = 0; i < nc; i++) want[i] = sc.nextDouble();

        WakeWord w = new WakeWord(net("mel"), net("emb"), net("hey"), init);
        double worst = 0;
        for (int i = 0; i < nc; i++) { float s = w.process(chunks[i]); worst = Math.max(worst, Math.abs(s - want[i])); }
        System.out.println("replayed " + pos + "/" + calls + " model calls; worst score difference " + worst);
        if (pos != calls || worst > 1e-6) { System.out.println("FAIL"); System.exit(1); }

        // auto-gain matches wake.py: quiet voice boosted, silence untouched
        WakeWord.AutoGain g = new WakeWord.AutoGain(6f);
        short[] quiet = new short[1280]; for (int i = 0; i < 1280; i++) quiet[i] = (short) (Math.sin(i / 5.0) * 1000);
        short[] q2 = g.apply(quiet); int pk = 0; for (short s : q2) pk = Math.max(pk, Math.abs(s));
        short[] hiss = new short[1280]; for (int i = 0; i < 1280; i++) hiss[i] = (short) ((i % 7) * 20 - 60);
        boolean ok = pk > 5000 && pk <= 6000 && new WakeWord.AutoGain(6f).apply(hiss) == hiss;
        System.out.println("auto-gain " + (ok ? "OK" : "FAIL") + " (quiet peak 1000 -> " + pk + ")");
        System.out.println(ok ? "PASS" : "FAIL"); System.exit(ok ? 0 : 1);
    }
}
