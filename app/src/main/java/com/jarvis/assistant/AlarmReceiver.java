package com.jarvis.assistant;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Rings reminders and timers (from AlarmManager) and handles Snooze / Done. Private: only Jarvis's own alarms reach it. */
public class AlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        String a = i.getAction() == null ? "" : i.getAction();
        String id = i.getStringExtra("id");
        switch (a) {
            case Reminders.ACTION_FIRE:
                if (id != null) Reminders.fire(c, id);
                break;
            case Reminders.ACTION_SNOOZE:
                if (id != null) Reminders.snooze(c, id, i.getStringExtra("text"), i.getStringExtra("kind"), 10);
                break;
            case Reminders.ACTION_DONE:
                if (id != null) try { ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(Reminders.notifId(id)); } catch (Exception ignored) { }
                break;
            default:
        }
    }
}
