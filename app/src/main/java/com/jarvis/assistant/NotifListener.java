package com.jarvis.assistant;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;

/**
 * Lets Jarvis read your notifications out loud ("read my messages"), announce new messages while you drive (if you
 * switch that on), and reply through the notification's own Reply button ("reply to John: on my way").
 * The user grants this in Android's notification access settings. Kept in memory only, never saved or uploaded
 * except as part of a question you ask Jarvis.
 */
public class NotifListener extends NotificationListenerService {
    private static final String TAG = "JarvisNotifs";
    static volatile NotifListener instance;
    /** Jarvis's page, while alive: hears about new messages (to announce them when that's switched on). */
    public interface Listener { void onMessage(JSONObject n); }
    static volatile Listener listener;

    static final class Item {
        String key, pkg, app, title, text, category, spoken; long when; boolean message; Notification.Action reply; RemoteInput input;
    }
    private static final LinkedList<Item> recent = new LinkedList<>();
    /** key -> last text seen, so a notification that is only being updated ("2 messages", "typing...") isn't announced again. */
    private static final java.util.HashMap<String, String> lastText = new java.util.HashMap<>();
    /** sender -> when Jarvis last announced them: a burst of five messages is one announcement, not five. */
    private static final java.util.HashMap<String, Long> lastSaid = new java.util.HashMap<>();
    static final long BURST_MS = 25000;
    private static final String[] MESSAGING = {"com.whatsapp", "com.whatsapp.w4b", "com.google.android.apps.messaging", "com.samsung.android.messaging",
            "org.telegram.messenger", "com.facebook.orca", "com.instagram.android", "com.snapchat.android", "com.discord", "com.Slack",
            "com.microsoft.teams", "org.thoughtcrime.securesms", "com.viber.voip", "com.android.mms", "com.google.android.apps.googlevoice", "com.textra"};

    @Override public void onListenerConnected() { instance = this; try { for (StatusBarNotification s : getActiveNotifications()) add(s, false); } catch (Exception ignored) { } }
    @Override public void onListenerDisconnected() { instance = null; }
    @Override public void onNotificationPosted(StatusBarNotification sbn) { add(sbn, true); }
    @Override public void onNotificationRemoved(StatusBarNotification sbn) { synchronized (recent) { Iterator<Item> it = recent.iterator(); while (it.hasNext()) if (it.next().key.equals(sbn.getKey())) it.remove(); } }

    static boolean isEnabled(Context c) {
        try {
            String s = Settings.Secure.getString(c.getContentResolver(), "enabled_notification_listeners");
            return s != null && s.contains(new ComponentName(c, NotifListener.class).flattenToString());
        } catch (Exception e) { return false; }
    }

    private String appLabel(String pkg) {
        try { PackageManager pm = getPackageManager(); ApplicationInfo ai = pm.getApplicationInfo(pkg, 0); return String.valueOf(pm.getApplicationLabel(ai)); }
        catch (Exception e) { return pkg; }
    }

    private static boolean isMessaging(String pkg, String category) {
        if (Notification.CATEGORY_MESSAGE.equals(category)) return true;
        for (String m : MESSAGING) if (m.equals(pkg)) return true;
        return false;
    }

    private void add(StatusBarNotification sbn, boolean fresh) {
        try {
            if (sbn == null || sbn.getPackageName().equals(getPackageName())) return;
            Notification n = sbn.getNotification();
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
            if (sbn.isOngoing() && !Notification.CATEGORY_CALL.equals(n.category)) return;   // music players, navigation, "Jarvis is listening"
            Bundle x = n.extras;
            Item it = new Item();
            it.key = sbn.getKey(); it.pkg = sbn.getPackageName(); it.app = appLabel(it.pkg); it.when = sbn.getPostTime(); it.category = n.category == null ? "" : n.category;
            it.title = str(x.getCharSequence(Notification.EXTRA_TITLE));
            CharSequence big = x.getCharSequence(Notification.EXTRA_BIG_TEXT);
            it.text = str(big != null ? big : x.getCharSequence(Notification.EXTRA_TEXT));
            CharSequence[] lines = x.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (lines != null && lines.length > 0) it.text = str(lines[lines.length - 1]);
            String msgSender = "";
            try {                                                    // chat apps: the newest message and who sent it (MessagingStyle)
                android.os.Parcelable[] ms = x.getParcelableArray(Notification.EXTRA_MESSAGES);
                if (ms != null && ms.length > 0 && ms[ms.length - 1] instanceof Bundle) {
                    Bundle b = (Bundle) ms[ms.length - 1];
                    CharSequence t = b.getCharSequence("text"); if (t != null && t.length() > 0) it.text = str(t);
                    CharSequence who = b.getCharSequence("sender");
                    if (who == null && Build.VERSION.SDK_INT >= 28) { Object pp = b.getParcelable("sender_person"); if (pp instanceof android.app.Person) who = ((android.app.Person) pp).getName(); }
                    if (who != null) msgSender = str(who);
                }
            } catch (Exception ignored) { }
            if (it.title.isEmpty() && it.text.isEmpty()) return;
            it.message = isMessaging(it.pkg, it.category);
            it.spoken = it.message ? MessageWords.spoken(it.app, it.pkg, msgSender.isEmpty() ? it.title : msgSender, it.text) : null;
            boolean announce = fresh && it.message && it.spoken != null;
            synchronized (lastText) {
                String prev = lastText.put(it.key, it.title + "\n" + it.text);
                if (prev != null && (prev.equals(it.title + "\n" + it.text) || (n.flags & Notification.FLAG_ONLY_ALERT_ONCE) != 0)) announce = false;   // an update, not a new message
                if (lastText.size() > 200) lastText.clear();
                String who = it.pkg + "|" + MessageWords.sender(msgSender.isEmpty() ? it.title : msgSender, it.app);
                Long was = lastSaid.get(who); long now = System.currentTimeMillis();
                if (announce && was != null && now - was < BURST_MS) announce = false;
                if (announce) lastSaid.put(who, now);
            }
            if (n.actions != null) for (Notification.Action a : n.actions) {
                RemoteInput[] ri = a.getRemoteInputs();
                if (ri != null && ri.length > 0) { it.reply = a; it.input = ri[0]; break; }
            }
            synchronized (recent) {
                Iterator<Item> i = recent.iterator();
                while (i.hasNext()) if (i.next().key.equals(it.key)) i.remove();
                recent.addFirst(it);
                while (recent.size() > 40) recent.removeLast();
            }
            Listener l = listener;
            if (announce && l != null) l.onMessage(toJson(it, 1));
        } catch (Exception e) { Log.w(TAG, "add", e); }
    }

    private static String str(CharSequence s) { return s == null ? "" : s.toString().replaceAll("\\s+", " ").trim(); }

    private static JSONObject toJson(Item it, int n) {
        JSONObject o = new JSONObject();
        try {
            o.put("n", n); o.put("app", it.app); o.put("title", it.title); o.put("text", it.text.length() > 400 ? it.text.substring(0, 400) + "…" : it.text);
            o.put("message", it.message); if (it.spoken != null) o.put("spoken", it.spoken); o.put("canReply", it.reply != null); o.put("ago", Math.max(0, (System.currentTimeMillis() - it.when) / 60000));
        } catch (Exception ignored) { }
        return o;
    }

    /** Most recent first. onlyMessages: just chats and texts. app: filter by app name (optional). */
    static String list(boolean onlyMessages, String app, int max) {
        JSONArray a = new JSONArray();
        String want = app == null ? "" : app.toLowerCase(Locale.ROOT).trim();
        synchronized (recent) {
            int n = 0;
            for (Item it : recent) {
                if (onlyMessages && !it.message) continue;
                if (!want.isEmpty() && !it.app.toLowerCase(Locale.ROOT).contains(want)) continue;
                a.put(toJson(it, ++n));
                if (n >= max) break;
            }
        }
        return a.toString();
    }

    /** Replies through the notification's Reply action. `who` matches the sender (title) or app; newest match wins. */
    static String reply(Context c, String who, String text) {
        String w = who == null ? "" : who.toLowerCase(Locale.ROOT).trim();
        Item target = null;
        synchronized (recent) {
            List<Item> withReply = new ArrayList<>();
            for (Item it : recent) if (it.reply != null) withReply.add(it);
            if (w.matches("\\d+")) { int i = Integer.parseInt(w) - 1; if (i >= 0 && i < withReply.size()) target = withReply.get(i); }
            if (target == null) for (Item it : withReply) {
                if (w.isEmpty() || it.title.toLowerCase(Locale.ROOT).contains(w) || it.app.toLowerCase(Locale.ROOT).contains(w)) { target = it; break; }
            }
        }
        if (target == null) return w.isEmpty() ? "There's no message I can reply to." : "I don't see a message from " + who + " that I can reply to.";
        try {
            Intent fill = new Intent();
            Bundle b = new Bundle();
            b.putCharSequence(target.input.getResultKey(), text);
            RemoteInput.addResultsToIntent(target.reply.getRemoteInputs(), fill, b);
            target.reply.actionIntent.send(c, 0, fill);
            return "Sent to " + (target.title.isEmpty() ? target.app : target.title) + " on " + target.app + ".";
        } catch (PendingIntent.CanceledException e) { return "That message's reply button has expired. Open the app to reply."; }
        catch (Exception e) { Log.w(TAG, "reply", e); return "The reply didn't go through."; }
    }
}
