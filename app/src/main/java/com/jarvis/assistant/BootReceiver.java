package com.jarvis.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a restart, an app update or a clock / time zone change, puts Jarvis's reminders and timers back. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) { Reminders.rescheduleAll(c); }
}
