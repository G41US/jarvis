import com.jarvis.assistant.OfferParser;
import com.jarvis.assistant.OfferParser.Offer;
import java.util.Calendar;
import java.util.List;
import static com.jarvis.assistant.OfferParser.lines;

/** Sample offer screens (text as Android's accessibility reads it). These are modelled on the real layouts and will be
 *  tuned with captures from real phones (Settings > Offer reader shows the last screen it read). */
public class OfferParserTest {
    static int fails = 0;
    static void check(String name, boolean ok, Object got) { System.out.println((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  -> " + got)); if (!ok) fails++; }
    static String d(Offer o) { return o == null ? "null" : String.format("pay=%.2f mi=%.1f min=%d est=%s store=%s orders=%d", o.payout, o.miles, o.minutes, o.minutesEstimated, o.store, o.orders); }

    public static void main(String[] a) {
        Calendar now = Calendar.getInstance(); now.set(Calendar.HOUR_OF_DAY, 19); now.set(Calendar.MINUTE, 10); now.set(Calendar.SECOND, 0);

        List<String> dd = lines("New Order", "$9.50", "Guaranteed (incl. tips)", "6.3 mi", "Deliver by 7:42 PM", "Chipotle", "1 order", "Decline", "Accept");
        Offer o = OfferParser.parse("com.doordash.driverapp", dd, now);
        check("DoorDash: pay, miles, store; deadline 32 min but drive ~27 min", o != null && o.payout == 9.50 && o.miles == 6.3 && o.minutes == 27 && "Chipotle".equals(o.store) && o.platform.equals("DoorDash"), d(o));
        check("DoorDash: $9.50 / 6.3 mi = $1.51/mi, ~$21/hr -> take", "take".equals(OfferParser.verdict(o, 18, 1.5)), OfferParser.spoken(o, 18, 1.5, "$"));
        System.out.println("   says: " + OfferParser.spoken(o, 18, 1.5, "$"));

        List<String> uber = lines("Delivery", "Exclusive", "$8.75", "incl. expected tip", "18 min (6.1 mi) total", "Wendy's", "Main St & 3rd Ave", "Accept");
        o = OfferParser.parse("com.ubercab.driver", uber, now);
        check("Uber: total time and distance from '18 min (6.1 mi) total'", o != null && o.payout == 8.75 && o.miles == 6.1 && o.minutes == 18 && "Wendy's".equals(o.store) && o.platform.equals("Uber Eats"), d(o));
        check("Uber: $8.75 / 6.1 mi = $1.43/mi but $29/hr -> your call", "maybe".equals(OfferParser.verdict(o, 18, 1.5)), OfferParser.spoken(o, 18, 1.5, "$"));
        System.out.println("   says: " + OfferParser.spoken(o, 18, 1.5, "$"));

        List<String> low = lines("$3.25", "Guaranteed (incl. tips)", "9.8 mi", "Deliver by 7:58 PM", "Taco Bell", "Decline", "Accept");
        o = OfferParser.parse("com.doordash.driverapp", low, now);
        check("lowball: $3.25 for 9.8 mi -> pass", o != null && "pass".equals(OfferParser.verdict(o, 18, 1.5)), d(o));
        System.out.println("   says: " + OfferParser.spoken(o, 18, 1.5, "$"));

        List<String> peak = lines("$11.25", "+$2.00 Peak Pay", "Guaranteed (incl. tips)", "4.1 mi", "Deliver by 7:35 PM", "McDonald's", "2 orders", "Accept", "Decline");
        o = OfferParser.parse("com.doordash.driverapp", peak, now);
        check("peak pay line is not taken as the total; 2 orders noticed", o != null && o.payout == 11.25 && o.orders == 2 && "McDonald's".equals(o.store), d(o));

        List<String> noTime = lines("$7.00", "Guaranteed (incl. tips)", "3.0 mi", "Panda Express", "Accept");
        o = OfferParser.parse("com.doordash.driverapp", noTime, now);
        check("no time shown -> estimated (8 min + 3 min per mile) and said so", o != null && o.minutes == 17 && o.minutesEstimated && OfferParser.spoken(o, 18, 1.5, "$").contains("if it takes 17 minutes"), d(o));

        List<String> dash = lines("Dash Now", "Earnings this week", "$212.40", "Busy area", "Schedule");
        check("dashboard screens with money on them are ignored (no Accept button)", OfferParser.parse("com.doordash.driverapp", dash, now) == null, "");

        List<String> active = lines("Pick up from", "Chipotle", "Directions", "Confirm pickup", "$9.50");
        check("an order already in progress is not an offer", OfferParser.parse("com.doordash.driverapp", active, now) == null, "");

        List<String> late = lines("$12.00", "Guaranteed (incl. tips)", "12.0 mi", "Deliver by 12:15 AM", "Denny's", "Accept");
        Calendar night = (Calendar) now.clone(); night.set(Calendar.HOUR_OF_DAY, 23); night.set(Calendar.MINUTE, 50);
        o = OfferParser.parse("com.doordash.driverapp", late, night);
        check("deadline after midnight -> 25 min (shorter than the 44 min drive estimate)", o != null && o.minutes == 25 && !o.minutesEstimated, d(o));

        List<String> hr = lines("$31.40", "incl. expected tip", "1 hr 5 min (24.3 mi) total", "Costco", "Accept");
        o = OfferParser.parse("com.ubercab.driver", hr, now);
        check("long trip '1 hr 5 min (24.3 mi) total' -> 65 min", o != null && o.minutes == 65 && o.miles == 24.3, d(o));

        System.out.println("FAILURES: " + fails); System.exit(fails == 0 ? 0 : 1);
    }
}
