import com.jarvis.assistant.MessageWords;

/** What Jarvis says for new messages: short, no emoji, nothing for typing / "3 new messages" / reactions. */
public class MessageWordsTest {
    static int bad = 0;
    static void eq(String got, String want, String what) {
        boolean ok = want == null ? got == null : want.equals(got);
        if (!ok) { bad++; System.out.println("FAIL " + what + "\n   got:  " + got + "\n   want: " + want); }
    }
    public static void main(String[] a) {
        String S = "com.snapchat.android", W = "com.whatsapp", M = "com.google.android.apps.messaging";
        eq(MessageWords.spoken("Snapchat", S, "Valerie🍒🫧", "sent you a voice note"), "Valerie sent you a voice note on Snapchat.", "snapchat voice note (emoji name)");
        eq(MessageWords.spoken("Snapchat", S, "Valerie🍒", "sent you a Snap"), "Valerie sent you a snap.", "snap");
        eq(MessageWords.spoken("Snapchat", S, "Valerie", "sent you a Chat"), "Valerie sent you a chat on Snapchat.", "snapchat chat");
        eq(MessageWords.spoken("Snapchat", S, "Valerie", "hey are you coming tonight?? 😂"), "Valerie sent you a chat on Snapchat.", "snapchat text is not read");
        eq(MessageWords.spoken("Snapchat", S, "Snapchat", "from Valerie"), "Valerie sent you a chat on Snapchat.", "snapchat 'from X'");
        eq(MessageWords.spoken("Snapchat", S, "Valerie", "Valerie is typing..."), null, "typing");
        eq(MessageWords.spoken("WhatsApp", W, "Tunde", "🎤 Voice message (0:12)"), "Tunde sent you a voice note on WhatsApp.", "whatsapp voice message");
        eq(MessageWords.spoken("WhatsApp", W, "Tunde", "📷 Photo"), "Tunde sent you a photo on WhatsApp.", "photo");
        eq(MessageWords.spoken("WhatsApp", W, "Tunde", "On my way, 5 mins"), "Tunde on WhatsApp: On my way, 5 mins.", "short text read");
        eq(MessageWords.spoken("WhatsApp", W, "Tunde (3 messages)", "See you"), "Tunde on WhatsApp: See you.", "count stripped");
        eq(MessageWords.spoken("WhatsApp", W, "Family 🏠: Mum", "Call me when you're free"), "Mum on WhatsApp: Call me when you're free.", "group sender");
        eq(MessageWords.spoken("WhatsApp", W, "WhatsApp", "5 new messages"), null, "summary");
        eq(MessageWords.spoken("WhatsApp", W, "WhatsApp", "Checking for new messages"), null, "checking");
        eq(MessageWords.spoken("WhatsApp", W, "Tunde", "This message was deleted"), null, "deleted");
        eq(MessageWords.spoken("WhatsApp", W, "Tunde", "Reacted 👍 to \"ok\""), null, "reaction");
        eq(MessageWords.spoken("WhatsApp", W, "Tunde", "Missed voice call"), "Missed call from Tunde on WhatsApp.", "missed call");
        eq(MessageWords.spoken("Messages", M, "Ada", "😂😂"), "Ada sent you an emoji on Messages.", "only emoji");
        eq(MessageWords.spoken("Messages", M, "Ada", "So I was thinking about what you said yesterday and honestly I think we should move the whole thing to next week because nobody is ready"),
                "Ada sent you a long message on Messages.", "long text not read");
        eq(MessageWords.spoken("Instagram", "com.instagram.android", "ada_b", "ada_b sent you a message."), "ada_b sent you a message on Instagram.", "instagram");
        eq(MessageWords.clean("**Hello** ✨ world #1"), "Hello world 1", "clean");
        System.out.println(bad == 0 ? "PASS messages" : "FAILURES: " + bad);
        if (bad > 0) System.exit(1);
    }
}
