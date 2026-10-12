import com.jarvis.assistant.PiperTts;
import java.io.File;
import java.util.concurrent.*;

/** Runs PiperTts.java with the real Piper engine (Linux build of the same library) and a real-time fake speaker. */
public class PiperTtsTest {
    public static void main(String[] a) throws Exception {
        final ConcurrentHashMap<Long, Long> done = new ConcurrentHashMap<>(); final ConcurrentHashMap<Long, Boolean> ok = new ConcurrentHashMap<>();
        PiperTts p = new PiperTts(new File(a[0]), new PiperTts.Events() {
            public void onDone(long id, boolean good) { done.put(id, System.nanoTime()); ok.put(id, good); }
            public void onStatus(String json) {}
        });
        boolean pass = true;
        p.use("alan"); Thread.sleep(4000);                                       // preload
        System.out.println("ready alan=" + p.isReady("alan") + " speaksNow=" + p.speaksNow());
        pass &= p.speaksNow();
        String s1 = "Good evening. Your next stop is Chipotle on Elm Street.";
        long t0 = System.nanoTime(); p.speak(1, s1);
        while (!done.containsKey(1L) && System.nanoTime() - t0 < 30e9) Thread.sleep(10);
        double took = (done.getOrDefault(1L, System.nanoTime()) - t0) / 1e9;
        System.out.printf("sentence 1: done=%s after %.2f s (speech is ~3.6 s long, so 'done' must wait for the speaker)%n", ok.get(1L), took);
        pass &= Boolean.TRUE.equals(ok.get(1L)) && took > 2.5 && took < 8;
        // stop mid-sentence: done comes back fast, and queued sentences are dropped (reported done)
        p.speak(2, "This is a long sentence that should be cut off part of the way through, because you started talking over me.");
        p.speak(3, "And this one never plays.");
        Thread.sleep(900); long ts = System.nanoTime(); p.stop();
        while ((!done.containsKey(2L) || !done.containsKey(3L)) && System.nanoTime() - ts < 5e9) Thread.sleep(10);
        double stopLag = (Math.max(done.getOrDefault(2L, Long.MAX_VALUE / 2), done.getOrDefault(3L, Long.MAX_VALUE / 2)) - ts) / 1e9;
        System.out.printf("stop: both reported done %.2f s after stop()%n", stopLag);
        pass &= stopLag < 1.5;
        // switch to Amy and speak again
        p.use("amy"); long t4 = System.nanoTime(); p.speak(4, "Hello. This is Amy.");
        while (!done.containsKey(4L) && System.nanoTime() - t4 < 30e9) Thread.sleep(10);
        System.out.printf("amy: done=%s after %.2f s%n", ok.get(4L), (done.getOrDefault(4L, System.nanoTime()) - t4) / 1e9);
        pass &= Boolean.TRUE.equals(ok.get(4L));
        p.use("bob"); p.speak(5, "no such voice"); long t5 = System.nanoTime();
        while (!done.containsKey(5L) && System.nanoTime() - t5 < 5e9) Thread.sleep(10);
        System.out.println("unknown voice -> reported failure (so the app falls back): " + Boolean.FALSE.equals(ok.get(5L)));
        pass &= Boolean.FALSE.equals(ok.get(5L));
        p.shutdown();
        System.out.println(pass ? "PASS" : "FAIL"); System.exit(pass ? 0 : 1);
    }
}
