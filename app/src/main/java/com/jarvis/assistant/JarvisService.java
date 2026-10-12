package com.jarvis.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/** Foreground service: the notification that tells Android "this app is actively using the microphone / location", so it is not put to sleep. */
public class JarvisService extends Service {
    private static final String CHANNEL = "jarvis_listening";
    private static final String ACTION_QUIT = "com.jarvis.assistant.QUIT";
    private PowerManager.WakeLock wake;

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_QUIT.equals(intent.getAction())) {
            stopForeground(true);
            stopSelf();
            android.os.Process.killProcess(android.os.Process.myPid());
            return START_NOT_STICKY;
        }
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Jarvis", NotificationManager.IMPORTANCE_LOW));

            PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            PendingIntent quit = PendingIntent.getService(this, 1, new Intent(this, JarvisService.class).setAction(ACTION_QUIT),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

            Notification n = new Notification.Builder(this, CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle(getString(R.string.notif_title))
                    .setContentText(getString(R.string.notif_text))
                    .setContentIntent(open)
                    .setOngoing(true)
                    .addAction(new Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat), getString(R.string.notif_quit), quit).build())
                    .build();

            int types = intent == null ? 0 : intent.getIntExtra("types", 0);
            if (Build.VERSION.SDK_INT >= 29) {
                int t = 0;
                if ((types & 1) != 0) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                if ((types & 2) != 0) t |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
                startForeground(7, n, t);
            } else {
                startForeground(7, n);
            }
            if (wake == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jarvis:listen");
                wake.setReferenceCounted(false);
                wake.acquire();
            }
        } catch (Exception e) {
            Log.w("JarvisService", "could not go foreground", e);
            stopSelf();
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
