import com.jarvis.assistant.FaceMath;

import java.io.DataInputStream;
import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;

/** Replays tests/face/trace.bin through FaceMath and compares every step with the reference pipeline (which matches OpenCV). */
public class FaceMathTest {
    static int fails = 0;
    static void check(String name, boolean ok, String extra) { System.out.println((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  -> " + extra)); if (!ok) fails++; }

    public static void main(String[] a) throws Exception {
        String dir = a.length > 0 ? a[0] : "tests/face";
        ByteBuffer bb = ByteBuffer.wrap(Files.readAllBytes(Paths.get(dir, "trace.bin"))).order(ByteOrder.LITTLE_ENDIAN);
        int w = bb.getInt(), h = bb.getInt();
        int[] rgb = new int[w * h];
        for (int i = 0; i < w * h; i++) { int r = bb.get() & 255, g = bb.get() & 255, b = bb.get() & 255; rgb[i] = (r << 16) | (g << 8) | b; }
        float[][][] o = new float[4][3][];
        for (int k = 0; k < 4; k++) for (int s = 0; s < 3; s++) { int n = bb.getInt(); o[k][s] = new float[n]; for (int i = 0; i < n; i++) o[k][s][i] = bb.getFloat(); }

        java.util.Map<String, String> ex = new java.util.HashMap<>();
        List<String> faceLines = new java.util.ArrayList<>();
        for (String line : Files.readAllLines(Paths.get(dir, "expected.txt"))) {
            int sp = line.indexOf(' ');
            String k = line.substring(0, sp), v = line.substring(sp + 1);
            if (k.equals("face")) faceLines.add(v); else ex.put(k, v);
        }

        // 1. letterbox
        FaceMath.Input in = FaceMath.letterbox(rgb, w, h);
        String[] sc = ex.get("scale").split(" ");
        check("letterbox scale", Math.abs(in.sx - Double.parseDouble(sc[0])) < 1e-6 && Math.abs(in.sy - Double.parseDouble(sc[1])) < 1e-6, in.sx + " " + in.sy);
        double sum = 0; for (float f : in.blob) sum += f;
        double want = Double.parseDouble(ex.get("blob_sum"));
        check("letterbox pixels (sum)", Math.abs(sum - want) / want < 1e-6, sum + " vs " + want);
        double worst = 0;
        for (String p : ex.get("blob").split(" ")) { String[] kv = p.split(":"); worst = Math.max(worst, Math.abs(in.blob[Integer.parseInt(kv[0])] - Double.parseDouble(kv[1]))); }
        check("letterbox pixels (400 samples, BGR planes)", worst < 2e-3, "max diff " + worst);

        // 2. decode + NMS
        List<FaceMath.Face> faces = FaceMath.decode(o[0], o[1], o[2], o[3], 0.6f, 0.3f, in.sx, in.sy);
        check("faces found", faces.size() == Integer.parseInt(ex.get("faces")), faces.size() + "");
        if (!faces.isEmpty()) {
            String[] e = faceLines.get(0).split(" ");
            FaceMath.Face f = faces.get(0);
            float[] got = {f.x, f.y, f.w, f.h, f.lm[0], f.lm[1], f.lm[2], f.lm[3], f.lm[4], f.lm[5], f.lm[6], f.lm[7], f.lm[8], f.lm[9], f.score};
            double d = 0; for (int i = 0; i < 15; i++) d = Math.max(d, Math.abs(got[i] - Double.parseDouble(e[i])));
            check("face box, landmarks and score", d < 1e-3, "max diff " + d);
            String[] cv = ex.get("opencv_face").split(" ");
            double dcv = 0; for (int i = 4; i < 14; i++) dcv = Math.max(dcv, Math.abs(got[i] - Double.parseDouble(cv[i])));
            check("landmarks agree with OpenCV's own detector (within 4 px)", dcv < 4, "max " + dcv);

            // 3. alignment
            double[] m = FaceMath.similarity(f.lm);
            String[] em = ex.get("M").split(" ");
            double dm = 0; for (int i = 0; i < 6; i++) dm = Math.max(dm, Math.abs(m[i] - Double.parseDouble(em[i])));
            check("alignment matrix", dm < 1e-4, "max diff " + dm);
            float[] al = FaceMath.alignedBlob(rgb, w, h, m);
            double as = 0; for (float x : al) as += x;
            double aw = Double.parseDouble(ex.get("aligned_sum"));
            check("aligned face (sum)", Math.abs(as - aw) / aw < 1e-5, as + " vs " + aw);
            double wa = 0;
            for (String p : ex.get("aligned").split(" ")) { String[] kv = p.split(":"); wa = Math.max(wa, Math.abs(al[Integer.parseInt(kv[0])] - Double.parseDouble(kv[1]))); }
            check("aligned face (400 samples, RGB planes)", wa < 0.02, "max diff " + wa);
        }
        float[] u = {1, 2, 3}, v = {2, 4, 6}, z = {3, -1.5f, 0};
        check("cosine", Math.abs(FaceMath.cosine(u, v) - 1) < 1e-9 && Math.abs(FaceMath.cosine(u, z)) < 1e-9, "");
        System.out.println(fails == 0 ? "PASS face math" : "FAILURES: " + fails);
        System.exit(fails == 0 ? 0 : 1);
    }
}
