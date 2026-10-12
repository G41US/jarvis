package com.jarvis.assistant;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Downloads one of the PC's Piper voices (the sherpa-onnx packaging of it) and unpacks it:
 *   <root>/<name>/model.onnx, <root>/<name>/tokens.txt, and the shared <root>/espeak-ng-data/.
 * Plain Java (no Android), so it is tested on a computer.
 */
public final class VoicePack {
    public interface Progress { void update(long done, long total); }

    public static final String BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/";
    /** name -> package. Same voices as the PC's voices/ folder. */
    public static String packageFor(String name) {
        if ("alan".equals(name)) return "vits-piper-en_GB-alan-medium";
        if ("amy".equals(name)) return "vits-piper-en_US-amy-medium";
        return null;
    }

    public static boolean isReady(File root, String name) {
        File d = new File(root, name);
        return new File(d, "model.onnx").length() > 1_000_000 && new File(d, "tokens.txt").isFile()
                && new File(new File(root, "espeak-ng-data"), "phontab").isFile();
    }

    public static void download(File root, String name, Progress p) throws IOException { download(root, name, BASE + packageFor(name) + ".tar.bz2", p); }

    public static void download(File root, String name, String url, Progress p) throws IOException {
        if (packageFor(name) == null && !url.startsWith("http://127.0.0.1")) throw new IOException("unknown voice " + name);
        root.mkdirs();
        File tmp = new File(root, ".tmp-" + name), espeakTmp = new File(root, ".tmp-espeak-" + name), espeak = new File(root, "espeak-ng-data");
        deleteTree(tmp); deleteTree(espeakTmp);
        boolean needEspeak = !new File(espeak, "phontab").isFile();
        HttpURLConnection c = open(url);
        final long total = c.getContentLengthLong();
        final long[] done = {0};
        try (InputStream raw = c.getInputStream();
             InputStream counted = new FilterInputStream(raw) {
                 long last = 0;
                 @Override public int read() throws IOException { int b = super.read(); if (b >= 0) tick(1); return b; }
                 @Override public int read(byte[] b, int o, int n) throws IOException { int r = super.read(b, o, n); if (r > 0) tick(r); return r; }
                 private void tick(int n) { done[0] += n; if (p != null && done[0] - last > 256 * 1024) { last = done[0]; p.update(done[0], total); } }
             };
             TarArchiveInputStream tar = new TarArchiveInputStream(new BZip2CompressorInputStream(new BufferedInputStream(counted, 1 << 16)))) {
            boolean gotModel = false, gotTokens = false;
            TarArchiveEntry e;
            while ((e = tar.getNextEntry()) != null) {
                String n = e.getName();
                int slash = n.indexOf('/');
                String rel = slash >= 0 ? n.substring(slash + 1) : n;                 // drop "vits-piper-.../"
                if (rel.isEmpty() || rel.contains("..") || e.isDirectory() || !e.isFile()) continue;
                File out;
                if (rel.endsWith(".onnx") && !rel.contains("/")) { out = new File(tmp, "model.onnx"); gotModel = true; }
                else if (rel.equals("tokens.txt")) { out = new File(tmp, "tokens.txt"); gotTokens = true; }
                else if (rel.startsWith("espeak-ng-data/") && needEspeak) out = new File(espeakTmp, rel.substring("espeak-ng-data/".length()));
                else continue;                                                       // model card, json, espeak data we already have
                out.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[1 << 16];
                    int r;
                    while ((r = tar.read(buf)) > 0) os.write(buf, 0, r);
                }
            }
            if (!gotModel || !gotTokens) throw new IOException("voice package is missing files");
        } finally { c.disconnect(); }
        if (needEspeak) { deleteTree(espeak); if (!espeakTmp.renameTo(espeak)) throw new IOException("could not save pronunciation data"); }
        File dest = new File(root, name);
        deleteTree(dest);
        if (!tmp.renameTo(dest)) throw new IOException("could not save voice");
        if (p != null) p.update(total > 0 ? total : done[0], total);
    }

    private static HttpURLConnection open(String url) throws IOException {
        for (int hops = 0; hops < 6; hops++) {                                     // GitHub redirects to its download host
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "Jarvis-Android");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) { String loc = c.getHeaderField("Location"); c.disconnect(); if (loc == null) break; url = new URL(new URL(url), loc).toString(); continue; }
            if (code != 200) { c.disconnect(); throw new IOException("download failed: HTTP " + code); }
            return c;
        }
        throw new IOException("too many redirects");
    }

    public static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
}
