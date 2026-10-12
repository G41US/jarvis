import com.jarvis.assistant.VoicePack;
import java.io.File;

/** Downloads a real Piper voice package from a local server (with a GitHub-style redirect), unpacks it, checks the layout,
 *  then downloads the second voice and checks the shared pronunciation data is reused. */
public class VoicePackTest {
    public static void main(String[] a) throws Exception {
        File root = new File(a[0]); VoicePack.class.getName();
        final long[] last = {0, 0}; final int[] ticks = {0};
        long t0 = System.currentTimeMillis();
        VoicePack.download(root, "alan", a[1] + "/redirect/alan", (d, t) -> { ticks[0]++; last[0] = d; last[1] = t; });
        boolean ok1 = VoicePack.isReady(root, "alan") && ticks[0] > 10 && last[0] == last[1];
        System.out.println("alan: ready=" + VoicePack.isReady(root, "alan") + " progress updates=" + ticks[0] + " final=" + last[0] + "/" + last[1] + " in " + (System.currentTimeMillis() - t0) + " ms");
        long espeakTime = new File(root, "espeak-ng-data/phontab").lastModified();
        Thread.sleep(1100);
        VoicePack.download(root, "amy", a[1] + "/redirect/amy", null);
        boolean ok2 = VoicePack.isReady(root, "amy") && new File(root, "espeak-ng-data/phontab").lastModified() == espeakTime;
        System.out.println("amy: ready=" + VoicePack.isReady(root, "amy") + " shared data reused=" + (new File(root, "espeak-ng-data/phontab").lastModified() == espeakTime));
        boolean noTmp = root.list((d, n) -> n.startsWith(".tmp")).length == 0;
        boolean bad = false; try { VoicePack.download(root, "bob", a[1] + "/missing", null); } catch (Exception e) { bad = true; }
        System.out.println("no temp left=" + noTmp + " missing file fails cleanly=" + bad + " (and alan still ready=" + VoicePack.isReady(root, "alan") + ")");
        boolean all = ok1 && ok2 && noTmp && bad && VoicePack.isReady(root, "alan");
        System.out.println(all ? "PASS" : "FAIL"); System.exit(all ? 0 : 1);
    }
}
