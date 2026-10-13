package com.jarvis.assistant;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What Jarvis says when a message arrives: short, and never the junk messaging apps post.
 * "Valerie sent you a voice note.", "Ada sent you a snap.", "Tunde on WhatsApp: on my way."
 * Returns null for things not worth saying out loud (typing..., "3 new messages", deleted messages, reactions).
 * Plain Java (no Android classes) so it is tested on the computer: tests/messages/MessageWordsTest.java.
 */
public final class MessageWords {
    private MessageWords() { }

    private static final Pattern JUNK = Pattern.compile(
            "^(\\d+ )?new messages?$|new messages? from \\d+ chats?|^\\d+ messages? from \\d+ chats?$|checking for (new )?messages|^\\d+ unread|typing|^sending|this message was deleted|message (was )?deleted"
            + "|^waiting for this message|^you have new messages?$|^new notifications?$|is live now|posted (a|to their) story|added to (their|your) story|^tap to (view|load|see)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern REACTION = Pattern.compile("^(\\S+ )?(reacted|liked|loved|laughed at|emphasi[sz]ed|disliked|questioned) ", Pattern.CASE_INSENSITIVE);
    private static final Pattern COUNT = Pattern.compile("\\s*\\(\\d+ (new )?messages?\\)\\s*$|\\s*\\(\\d+\\)\\s*$", Pattern.CASE_INSENSITIVE);

    /** Removes emoji and other symbols; keeps letters, digits, spaces and ordinary punctuation. */
    public static String clean(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder();
        int i = 0;
        while (i < s.length()) {
            int cp = s.codePointAt(i); i += Character.charCount(cp);
            int t = Character.getType(cp);
            boolean keep = Character.isLetterOrDigit(cp) || Character.isWhitespace(cp)
                    || (cp < 0x2000 && t != Character.OTHER_SYMBOL && t != Character.MODIFIER_SYMBOL && t != Character.SURROGATE && t != Character.PRIVATE_USE && t != Character.FORMAT && t != Character.UNASSIGNED && cp != '*' && cp != '#' && cp != '~' && cp != '|')
                    || cp == '’' || cp == '‘';
            if (keep) b.appendCodePoint(Character.isWhitespace(cp) ? ' ' : cp);
        }
        return b.toString().replaceAll("\\s+", " ").replaceAll("\\s+([,.!?:;])", "$1").trim();
    }

    /** The sender's name from a notification title: "Family: Tunde" or "Tunde @ Family" -> Tunde; "Ada (3 messages)" -> Ada. */
    public static String sender(String title, String appName) {
        String t = COUNT.matcher(title == null ? "" : title).replaceAll("").trim();
        int at = t.indexOf(" @ ");
        if (at > 0) t = t.substring(0, at);
        else {
            int colon = t.lastIndexOf(": ");
            if (colon > 0 && colon < t.length() - 2) t = t.substring(colon + 2);
        }
        t = clean(t).replaceAll("[:\\-–]+$", "").trim();
        if (t.isEmpty() || (appName != null && t.equalsIgnoreCase(appName))) return "";
        return t;
    }

    private static boolean has(String low, String... any) { for (String a : any) if (low.contains(a)) return true; return false; }

    /** The words to say for a new message, or null to say nothing. */
    public static String spoken(String appName, String pkg, String title, String text) {
        String app = clean(appName), raw = text == null ? "" : text.trim(), p = pkg == null ? "" : pkg;
        String who = sender(title, app);
        // "Tunde: hey" inside the text (group chats, Snapchat): the name in the text wins when the title is the app or a group
        Matcher m = Pattern.compile("^([^:]{1,40}):\\s+(.+)$", Pattern.DOTALL).matcher(raw);
        if (m.find() && (who.isEmpty() || title == null || title.contains(":") || p.contains("snapchat"))) {
            String n = clean(m.group(1));
            if (!n.isEmpty() && n.split(" ").length <= 4) { who = n; raw = m.group(2).trim(); }
        }
        String low = raw.toLowerCase(Locale.ROOT);
        if (who.isEmpty()) {                                                    // Snapchat: "from Valerie", "Valerie sent you a Snap"
            String c = clean(raw);
            Matcher f = Pattern.compile("\\bfrom ([\\p{L}][\\p{L}' .\\-]{0,30}?)$", Pattern.CASE_INSENSITIVE).matcher(c);
            Matcher g = Pattern.compile("^([\\p{L}][\\p{L}' .\\-]{0,30}?) (sent you|is |added|mentioned)", Pattern.CASE_INSENSITIVE).matcher(c);
            if (f.find()) who = f.group(1).trim(); else if (g.find()) who = g.group(1).trim();
        }
        if (who.isEmpty()) who = "Someone";
        if (raw.isEmpty() && title != null && title.toLowerCase(Locale.ROOT).contains("sent you")) low = title.toLowerCase(Locale.ROOT);
        if (JUNK.matcher(low).find() || JUNK.matcher(title == null ? "" : title).find()) return null;
        if (REACTION.matcher(low).find()) return null;
        String on = app.isEmpty() ? "" : " on " + app;

        if (has(low, "missed voice call", "missed video call", "missed call")) return "Missed call from " + who + on + ".";
        if (has(low, "incoming voice call", "incoming video call", "calling you", "ringing")) return null;          // the phone rings by itself
        if (has(low, "voice message", "voice note", "voice memo", "audio message", "sent you an audio", "sent an audio", "🎤", "🎙"))
            return who + " sent you a voice note" + on + ".";
        boolean snapchat = p.contains("snapchat") || app.equalsIgnoreCase("snapchat");
        if (has(low, "sent you a snap", "sent a snap", "new snap", "sent you snaps", "snaps from")) return who + " sent you a snap.";
        if (snapchat) {
            if (has(low, "added you", "accepted your friend")) return who + " added you on Snapchat.";
            if (has(low, "mentioned you")) return who + " mentioned you on Snapchat.";
            if (has(low, "screenshot")) return who + " took a screenshot of your chat.";
            return who + " sent you a chat on Snapchat.";
        }
        if (has(low, "📷", "sent you a photo", "sent a photo", "sent an image", "sent you an image") || low.matches("^(photo|image|picture)s?$"))
            return who + " sent you a photo" + on + ".";
        if (has(low, "🎥", "📹", "sent you a video", "sent a video") || low.matches("^videos?( \\(.*\\))?$"))
            return who + " sent you a video" + on + ".";
        if (has(low, "sticker")) return who + " sent you a sticker" + on + ".";
        if (has(low, "gif")) return who + " sent you a GIF" + on + ".";
        if (has(low, "📄", "sent you a document", "sent a document", "sent a file", ".pdf", ".docx")) return who + " sent you a document" + on + ".";
        if (has(low, "📍", "live location", "shared a location", "sent a location", "sent you a location")) return who + " sent you a location" + on + ".";
        if (has(low, "👤", "sent a contact", "sent you a contact")) return who + " sent you a contact" + on + ".";
        if (has(low, "sent you a message", "sent a message", "new message", "messaged you")) return who + " sent you a message" + on + ".";
        String words = clean(raw);
        if (words.isEmpty() || !words.matches("(?s).*[\\p{L}\\p{N}].*")) return raw.isEmpty() ? null : who + " sent you an emoji" + on + ".";
        if (words.split(" ").length > 18 || words.length() > 120) return who + " sent you a long message" + on + ".";
        return who + on + ": " + words + (words.matches("(?s).*[.!?]$") ? "" : ".");
    }
}
