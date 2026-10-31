package com.jarvis.assistant;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Installs a newer Jarvis: downloads it from the Jarvis service straight into Android's installer, which then asks the
 *  user to tap Update (Android always asks for apps installed from outside the Play Store). Progress goes to the page. */
final class Updater {
    interface Report { void send(String json); }
    static final String ACTION = "com.jarvis.assistant.UPDATE_STATUS";
    private static final String TAG = "JarvisUpdate";
    private static Report report;
    private static volatile boolean busy;

    /** "started", "busy", or "permission" (Android's "Install unknown apps" switch for Jarvis is opened first). */
    static String start(final Activity a, final String url, final String token, Report r) {
        if (busy) return "busy";
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
            return "permission";
        }
        report = r; busy = true;
        new Thread(new Runnable() { public void run() { download(a, url, token); } }, "jarvis-update").start();
        return "started";
    }

    private static void download(Activity a, String url, String token) {
        PackageInstaller pi = a.getPackageManager().getPackageInstaller();
        int sid = -1;
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestProperty("x-jarvis-token", token);
            c.setConnectTimeout(20000); c.setReadTimeout(60000);
            if (c.getResponseCode() != 200) throw new IOException("the Jarvis service answered " + c.getResponseCode());
            long total = c.getContentLengthLong();
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(a.getPackageName());
            if (total > 0) p.setSize(total);
            sid = pi.createSession(p);
            PackageInstaller.Session s = pi.openSession(sid);
            long done = 0; int last = -1;
            try (InputStream in = c.getInputStream(); OutputStream out = s.openWrite("jarvis.apk", 0, total)) {
                byte[] buf = new byte[1 << 16]; int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n); done += n;
                    int pct = total > 0 ? (int) (done * 100 / total) : -1;
                    if (pct / 5 != last) { last = pct / 5; send("{\"state\":\"downloading\",\"percent\":" + pct + "}"); }
                }
                s.fsync(out);
            }
            if (total > 0 && done != total) throw new IOException("the download was cut off");   // never hand Android half an APK
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);   // mutable: Android adds the result
            Intent back = new Intent(a, MainActivity.class).setAction(ACTION);
            s.commit(PendingIntent.getActivity(a, sid, back, flags).getIntentSender());
            s.close();
            send("{\"state\":\"installing\"}");
        } catch (Exception e) {
            Log.w(TAG, "update failed", e);
            if (sid >= 0) try { pi.abandonSession(sid); } catch (Exception ignored) {}
            fail(String.valueOf(e.getMessage()));
        }
    }

    /** Android's answer, delivered to MainActivity: show its "Update?" screen, or report how it ended. */
    static void onStatus(Activity a, Intent i) {
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); a.startActivity(confirm); send("{\"state\":\"confirm\"}"); }
        } else if (st == PackageInstaller.STATUS_SUCCESS) {
            busy = false; send("{\"state\":\"done\"}");      // usually never seen: Android restarts Jarvis as the new build
        } else {
            fail(st == PackageInstaller.STATUS_FAILURE_ABORTED ? "cancelled" : String.valueOf(i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)));
        }
    }

    private static void fail(String why) {
        busy = false;
        send("{\"state\":\"failed\",\"error\":" + org.json.JSONObject.quote(why) + "}");
    }

    private static void send(String json) { Report r = report; if (r != null) r.send(json); }
}
