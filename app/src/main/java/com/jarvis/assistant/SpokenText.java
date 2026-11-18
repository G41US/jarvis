package com.jarvis.assistant;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Spoken sounds and stage directions, made right for each voice (same rules as the PC's _voice_text).
 *  The phone's offline voices spell "hm" and "mm" out as letters (H-M, M-M) and would read "[warm]" aloud; the cloud
 *  voice (Orpheus) acts on "[warm]"-style directions and says the sounds properly. */
final class SpokenText {
    private SpokenText() { }

    private static final Pattern DIRECTION = Pattern.compile("\\[([A-Za-z][A-Za-z \\-]{1,28})\\]\\s*");
    private static final Pattern STAGE = Pattern.compile("[*(]\\s*(laughs?|laughing|chuckles?|chuckling|giggles?|sighs?|sighing|smiles?|grins?)\\s*[*)]\\s*",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern AGREE = Pattern.compile("\\b(?:[Mm]-?hm+|[Mm]m-hm+|[Mm]hmm|[Uu]h-hm+)\\b");
    private static final Pattern HM = Pattern.compile("\\b[Hh]m+\\b");
    private static final Pattern MM = Pattern.compile("\\b[Mm]{2,}\\b");
    private static final Pattern NO_SOUND = Pattern.compile("\\b(?:[Pp]ff+t?|[Pp]sh+|[Tt]sk)\\b[,.!]?\\s*");

    /** For the cloud voice: keeps directions, turns "(laughs)" into one it acts. */
    static String cloud(String text) {
        if (text == null) return "";
        Matcher m = STAGE.matcher(text); StringBuffer b = new StringBuffer();
        while (m.find()) {
            String w = m.group(1).toLowerCase();
            String d = w.startsWith("laug") ? "laughing" : w.startsWith("chuc") ? "chuckling" : w.startsWith("gigg") ? "giggling" : w.startsWith("sigh") ? "sigh" : "warm";
            m.appendReplacement(b, Matcher.quoteReplacement("[" + d + "] "));
        }
        m.appendTail(b);
        String t = b.toString();
        t = AGREE.matcher(t).replaceAll("\u0001");                                  // agreeing, kept aside so the next two leave it alone
        t = HM.matcher(t).replaceAll("Hmm");
        t = MM.matcher(t).replaceAll("Mmm");
        return t.replace("\u0001", "Mm-hmm").replaceAll("\\s{2,}", " ").trim();
    }

    /** For the offline voices: no directions, sounds spelled so they're said, not spelled out. */
    static String offline(String text) {
        if (text == null) return "";
        Matcher m = STAGE.matcher(text); StringBuffer b = new StringBuffer();
        while (m.find()) {
            String w = m.group(1).toLowerCase();
            m.appendReplacement(b, Matcher.quoteReplacement(w.startsWith("laug") || w.startsWith("chuc") || w.startsWith("gigg") ? "Ha! " : ""));
        }
        m.appendTail(b);
        String t = DIRECTION.matcher(b.toString()).replaceAll("");
        t = AGREE.matcher(t).replaceAll("\u0001");
        t = HM.matcher(t).replaceAll("Hmm");
        t = MM.matcher(t).replaceAll("Hmm");
        t = NO_SOUND.matcher(t).replaceAll("");
        return t.replace("\u0001", "Hmm-hmm").replaceAll("\\s{2,}", " ").trim();
    }
}
