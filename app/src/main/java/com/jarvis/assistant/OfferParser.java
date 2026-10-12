package com.jarvis.assistant;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads a delivery offer from the words on the DoorDash (Dasher) or Uber Driver screen and judges it.
 * Read-only: it never taps anything. Plain Java, so it is tested on a computer with sample screens.
 */
public final class OfferParser {
    public static final class Offer {
        public String platform = "", store = "";
        public double payout = 0, miles = 0;
        public int minutes = 0;                 // total time for the job, when the screen shows it (or a deadline does)
        public boolean minutesEstimated = false;
        public int orders = 1;
        public String key() { return platform + "|" + Math.round(payout * 100) + "|" + Math.round(miles * 10) + "|" + store; }
    }

    private static final Pattern MONEY = Pattern.compile("(?<![\\w.])\\+?\\$\\s?(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?)");
    private static final Pattern MILES = Pattern.compile("(\\d{1,3}(?:\\.\\d{1,2})?)\\s?(?:mi|miles?)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern MINUTES = Pattern.compile("(\\d{1,3})\\s?(?:min|mins|minutes)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern HOURS_MIN = Pattern.compile("(\\d{1,2})\\s?(?:hr|hrs|hour|hours)\\s?(\\d{1,2})?\\s?(?:min|mins)?", Pattern.CASE_INSENSITIVE);
    private static final Pattern DEADLINE = Pattern.compile("(?:deliver|drop ?off|due)\\s*(?:by|before)\\s*(\\d{1,2}):(\\d{2})\\s*([AaPp])\\.?\\s?[Mm]?", Pattern.CASE_INSENSITIVE);
    private static final Pattern ORDERS = Pattern.compile("(\\d)\\s+(?:orders|deliveries|stops)\\b", Pattern.CASE_INSENSITIVE);

    /** texts: every piece of text on the screen, top to bottom. now: current time. Returns null if this isn't an offer. */
    public static Offer parse(String pkg, List<String> texts, Calendar now) {
        String platform = pkg != null && pkg.contains("doordash") ? "DoorDash" : pkg != null && pkg.contains("ubercab") ? "Uber Eats" : "";
        StringBuilder all = new StringBuilder();
        boolean accept = false, decline = false;
        for (String t : texts) {
            if (t == null) continue;
            String s = t.trim();
            if (s.isEmpty()) continue;
            all.append(s).append('\n');
            String l = s.toLowerCase(Locale.US);
            if (l.equals("accept") || l.startsWith("accept ") || l.contains("tap to accept") || l.equals("accept order")) accept = true;
            if (l.equals("decline") || l.startsWith("decline") || l.equals("reject") || l.equals("no thanks")) decline = true;
        }
        String text = all.toString();
        if (!accept) return null;                                                   // only real offer cards have an Accept button

        Offer o = new Offer();
        o.platform = platform;

        // pay: the headline amount. Prefer a line that is just the amount, or one labelled guaranteed / incl. tip / total.
        double best = 0, labelled = 0, maxSeen = 0;
        String[] lines = text.split("\n");
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i], low = line.toLowerCase(Locale.US);
            Matcher m = MONEY.matcher(line);
            while (m.find()) {
                if (line.trim().startsWith("+") || low.contains("peak pay") || low.contains("boost") || low.contains("promo")) continue;   // add-ons, already in the total
                double v = Double.parseDouble(m.group(1).replace(",", ""));
                if (v < 2 || v > 500) continue;
                maxSeen = Math.max(maxSeen, v);
                String near = (low + " " + (i + 1 < lines.length ? lines[i + 1].toLowerCase(Locale.US) : "")).trim();
                if (near.contains("guaranteed") || near.contains("incl") || near.contains("total") || near.contains("estimated") || near.contains("est.")) labelled = Math.max(labelled, v);
                if (line.trim().matches("\\+?\\$\\s?[\\d,]+(\\.\\d{1,2})?")) best = Math.max(best, v);
            }
        }
        o.payout = labelled > 0 ? labelled : best > 0 ? best : maxSeen;
        if (o.payout <= 0) return null;

        // distance: "total" distance if labelled, otherwise the largest figure on the card
        double miles = 0, totalMiles = 0;
        for (String line : lines) {
            Matcher m = MILES.matcher(line);
            while (m.find()) {
                double v = Double.parseDouble(m.group(1));
                if (v <= 0 || v > 200) continue;
                miles = Math.max(miles, v);
                if (line.toLowerCase(Locale.US).contains("total")) totalMiles = Math.max(totalMiles, v);
            }
        }
        o.miles = totalMiles > 0 ? totalMiles : miles;
        if (o.miles <= 0) return null;

        // time: "18 min (6.1 mi) total", "1 hr 5 min", or a "Deliver by 7:42 PM" deadline
        int minutes = 0;
        for (String line : lines) {
            String low = line.toLowerCase(Locale.US);
            Matcher h = HOURS_MIN.matcher(line);
            if (h.find() && (low.contains("total") || low.contains("trip"))) { minutes = Integer.parseInt(h.group(1)) * 60 + (h.group(2) != null ? Integer.parseInt(h.group(2)) : 0); break; }
            Matcher m = MINUTES.matcher(line);
            if (m.find() && (low.contains("total") || low.contains("trip") || low.contains("(") )) { minutes = Math.max(minutes, Integer.parseInt(m.group(1))); }
        }
        int estimate = (int) Math.round(8 + o.miles * 3.0);                         // pickup wait + about 20 mph
        if (minutes == 0) {
            Matcher d = DEADLINE.matcher(text);
            if (d.find() && now != null) {
                int hh = Integer.parseInt(d.group(1)) % 12, mm = Integer.parseInt(d.group(2));
                if (d.group(3).equalsIgnoreCase("p")) hh += 12;
                Calendar due = (Calendar) now.clone();
                due.set(Calendar.HOUR_OF_DAY, hh); due.set(Calendar.MINUTE, mm); due.set(Calendar.SECOND, 0);
                if (due.before(now)) due.add(Calendar.DAY_OF_MONTH, 1);
                long mins = (due.getTimeInMillis() - now.getTimeInMillis()) / 60000L;
                // a "deliver by" time is a generous deadline, not how long the job takes: use the drive estimate if it's shorter
                if (mins > 0 && mins < 180) { minutes = (int) Math.min(mins, estimate); if (estimate < mins) o.minutesEstimated = true; }
            }
        }
        if (minutes == 0) { minutes = estimate; o.minutesEstimated = true; }
        o.minutes = minutes;

        Matcher or = ORDERS.matcher(text);
        if (or.find()) o.orders = Integer.parseInt(or.group(1));

        // the store: the first line that looks like a name (not money, distance, time or a button)
        for (String line : lines) {
            String s = line.trim(), low = s.toLowerCase(Locale.US);
            if (s.length() < 3 || s.length() > 40) continue;
            if (MONEY.matcher(s).find() || MILES.matcher(s).find() || MINUTES.matcher(s).find() || DEADLINE.matcher(s).find() || s.matches(".*\\d{1,2}:\\d{2}.*")) continue;
            if (low.matches(".*\\b(accept|decline|reject|guaranteed|incl|tip|total|order|orders|deliver|delivery|pickup|pick up|drop|exclusive|estimated|request|offer|dasher|uber|doordash|stop|stops|customer|items?|more|details?|close|back|now|minute|minutes|mile|miles)\\b.*")) continue;
            if (!s.matches(".*[A-Za-z].*")) continue;
            o.store = s;
            break;
        }
        return o;
    }

    /** "take" when both floors are met, "maybe" when one is, "pass" when neither. Same rule as the delivery copilot. */
    public static String verdict(Offer o, double minPerHour, double minPerMile) {
        double perMile = o.payout / o.miles, perHour = o.payout / (o.minutes / 60.0);
        boolean okHr = perHour >= minPerHour, okMi = perMile >= minPerMile;
        return okHr && okMi ? "take" : okHr || okMi ? "maybe" : "pass";
    }

    /** What Jarvis says. Short: the driver is looking at the screen. */
    public static String spoken(Offer o, double minPerHour, double minPerMile, String currency) {
        double perMile = o.payout / o.miles, perHour = o.payout / (o.minutes / 60.0);
        String v = verdict(o, minPerHour, minPerMile);
        String head = v.equals("take") ? "Take it." : v.equals("pass") ? "Pass." : "Your call.";
        String c = currency == null || currency.isEmpty() ? "$" : currency;
        String s = String.format(Locale.US, "%s %s%.2f for %s miles, %s%.2f a mile, about %s%d an hour", head, c, o.payout, trim(o.miles), c, perMile, c, Math.round(perHour));
        if (o.minutesEstimated) s += " if it takes " + o.minutes + " minutes";
        if (v.equals("maybe")) s += perMile < minPerMile ? ", under your per-mile floor" : ", under your hourly floor";
        if (o.orders > 1) s += ", " + o.orders + " orders";
        return s + ".";
    }

    private static String trim(double d) { return d == Math.rint(d) ? String.valueOf((long) d) : String.format(Locale.US, "%.1f", d); }

    public static List<String> lines(String... t) { List<String> l = new ArrayList<>(); for (String s : t) l.add(s); return l; }
}
