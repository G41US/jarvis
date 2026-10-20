package com.jarvis.assistant;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * The home-screen widget: a talk button and two lines (the next stop while you have orders, otherwise what you made today).
 * Tapping the button opens Jarvis listening; tapping the text opens him (on the Earnings page when it shows your pay).
 * The page sends the lines through Bridge.widget(); they're kept here so the widget survives restarts.
 */
public class JarvisWidget extends AppWidgetProvider {
    static final String PREFS = "jarvis_widget";

    @Override public void onUpdate(Context c, AppWidgetManager m, int[] ids) { for (int id : ids) m.updateAppWidget(id, views(c)); }

    static RemoteViews views(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_jarvis);
        v.setTextViewText(R.id.w_line1, p.getString("line1", "Tap to talk"));
        v.setTextViewText(R.id.w_line2, p.getString("line2", "Or say “Hey Jarvis” any time"));
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent talk = new Intent(c, MainActivity.class).setAction(MainActivity.ACTION_TALK).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        v.setOnClickPendingIntent(R.id.w_talk, PendingIntent.getActivity(c, 1, talk, flags));
        Intent open = new Intent(c, MainActivity.class).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        String tap = p.getString("open", "");
        if (!tap.isEmpty()) open.putExtra("open", tap);
        v.setOnClickPendingIntent(R.id.w_text, PendingIntent.getActivity(c, 2, open, flags));
        return v;
    }

    /** From the page: {"line1": "...", "line2": "...", "open": "earnings" | ""}. */
    static void update(Context c, String json) {
        try {
            JSONObject o = new JSONObject(json);
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString("line1", o.optString("line1", "Tap to talk"))
                    .putString("line2", o.optString("line2", ""))
                    .putString("open", o.optString("open", "")).apply();
            AppWidgetManager m = AppWidgetManager.getInstance(c);
            int[] ids = m.getAppWidgetIds(new ComponentName(c, JarvisWidget.class));
            if (ids.length > 0) m.updateAppWidget(ids, views(c));
        } catch (Exception ignored) { }
    }

    static int count(Context c) {
        try { return AppWidgetManager.getInstance(c).getAppWidgetIds(new ComponentName(c, JarvisWidget.class)).length; } catch (Exception e) { return 0; }
    }

    /** Asks the launcher to place the widget (Android 8+, if the launcher supports it). */
    static String pin(Context c) {
        try {
            AppWidgetManager m = AppWidgetManager.getInstance(c);
            if (Build.VERSION.SDK_INT < 26 || !m.isRequestPinAppWidgetSupported()) return "unsupported";
            return m.requestPinAppWidget(new ComponentName(c, JarvisWidget.class), null, null) ? "asked" : "unsupported";
        } catch (Exception e) { return "unsupported"; }
    }
}
