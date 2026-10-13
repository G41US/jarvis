import Foundation
import UserNotifications

/// Reminders, timers, alarms and the morning briefing as iPhone notifications (port of Reminders.java).
/// Items: {id, at (epoch ms), kind: reminder|timer|alarm|briefing, text, repeat: ""|daily|weekdays|weekly}.
final class Reminders: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private let d = UserDefaults.standard
    /// The page's handler: (item JSON, Jarvis on screen?)
    var onFire: (String, Bool) -> Void = { _, _ in }
    var isVisible: () -> Bool = { false }

    override init() {
        super.init()
        center.delegate = self
        let snooze = UNNotificationAction(identifier: "snooze", title: "Snooze 10 min", options: [])
        let done = UNNotificationAction(identifier: "done", title: "Done", options: [])
        center.setNotificationCategories([UNNotificationCategory(identifier: "jv.reminder", actions: [snooze, done], intentIdentifiers: [], options: [])])
    }

    // ---- storage
    private func all() -> [[String: Any]] { (JSBridge.parse(d.string(forKey: "reminders.items") ?? "[]") as? [[String: Any]]) ?? [] }
    private func save(_ a: [[String: Any]]) { d.set(JSBridge.json(a), forKey: "reminders.items") }
    private static func id(_ o: [String: Any]) -> String { "\(o["id"] ?? "")" }
    private static func at(_ o: [String: Any]) -> Double { (o["at"] as? NSNumber)?.doubleValue ?? 0 }

    /// Adds (or replaces) and schedules. Returns "exact": iPhone rings notifications on the minute.
    func add(_ json: String) -> String {
        guard var item = JSBridge.parse(json) as? [String: Any] else { return "error" }
        let id = Reminders.id(item)
        if id.isEmpty { return "error" }
        if Reminders.at(item) < Date().timeIntervalSince1970 * 1000 + 1000 { item["at"] = Date().timeIntervalSince1970 * 1000 + 1000 }
        var a = all().filter { Reminders.id($0) != id }
        a.append(item)
        save(a)
        schedule(item)
        return "exact"
    }

    func cancel(_ id: String) -> Bool {
        let had = all().contains { Reminders.id($0) == id }
        save(all().filter { Reminders.id($0) != id })
        let ids = Reminders.requestIds(id)
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
        return had
    }

    /// The pending ones (one-off reminders that already rang are dropped; repeating ones show their next time).
    func list() -> String {
        let now = Date().timeIntervalSince1970 * 1000
        var out: [[String: Any]] = []
        var changed = false
        for var o in all() {
            let rep = (o["repeat"] as? String) ?? ""
            if Reminders.at(o) <= now {
                if rep.isEmpty { changed = true; continue }
                o["at"] = Reminders.next(Reminders.at(o), rep, from: now); changed = true
            }
            out.append(o)
        }
        if changed { save(out) }
        return JSBridge.json(out)
    }

    static func next(_ at: Double, _ rep: String, from: Double) -> Double {
        let cal = Calendar.current
        var t = Date(timeIntervalSince1970: at / 1000)
        let now = Date(timeIntervalSince1970: from / 1000)
        var guardN = 0
        while t <= now && guardN < 800 {
            guardN += 1
            t = cal.date(byAdding: .day, value: rep == "weekly" ? 7 : 1, to: t) ?? t.addingTimeInterval(86400)
            if rep == "weekdays" { while cal.isDateInWeekend(t) { t = cal.date(byAdding: .day, value: 1, to: t) ?? t.addingTimeInterval(86400) } }
        }
        return t.timeIntervalSince1970 * 1000
    }

    private static func requestIds(_ id: String) -> [String] { ["jv-\(id)"] + (1...7).map { "jv-\(id)-w\($0)" } }

    private func schedule(_ item: [String: Any]) {
        let id = Reminders.id(item), kind = (item["kind"] as? String) ?? "reminder", text = (item["text"] as? String) ?? ""
        let rep = (item["repeat"] as? String) ?? ""
        center.removePendingNotificationRequests(withIdentifiers: Reminders.requestIds(id))
        let c = UNMutableNotificationContent()
        let timer = kind == "timer", briefing = kind == "briefing", alarm = kind == "alarm"
        c.title = timer ? "Timer done" : briefing ? "Good morning" : alarm ? "Alarm" : "Reminder"
        c.body = briefing ? "Your morning briefing. Tap to hear it." : text.isEmpty ? (timer ? "Your timer is up." : alarm ? "Time to get up." : "You asked me to remind you.")
            : (timer && text.lowercased() != "timer" ? "\(text) timer is up." : text)
        c.sound = .default
        c.categoryIdentifier = "jv.reminder"
        c.userInfo = ["item": JSBridge.json(item)]
        let when = Date(timeIntervalSince1970: Reminders.at(item) / 1000)
        let cal = Calendar.current
        var reqs: [UNNotificationRequest] = []
        switch rep {
        case "daily":
            reqs.append(UNNotificationRequest(identifier: "jv-\(id)", content: c, trigger: UNCalendarNotificationTrigger(dateMatching: cal.dateComponents([.hour, .minute], from: when), repeats: true)))
        case "weekly":
            reqs.append(UNNotificationRequest(identifier: "jv-\(id)", content: c, trigger: UNCalendarNotificationTrigger(dateMatching: cal.dateComponents([.weekday, .hour, .minute], from: when), repeats: true)))
        case "weekdays":
            for wd in 2...6 {
                var dc = cal.dateComponents([.hour, .minute], from: when); dc.weekday = wd
                reqs.append(UNNotificationRequest(identifier: "jv-\(id)-w\(wd)", content: c, trigger: UNCalendarNotificationTrigger(dateMatching: dc, repeats: true)))
            }
        default:
            let secs = max(1, when.timeIntervalSinceNow)
            reqs.append(UNNotificationRequest(identifier: "jv-\(id)", content: c, trigger: UNTimeIntervalNotificationTrigger(timeInterval: secs, repeats: false)))
        }
        for r in reqs { center.add(r) { e in if let e = e { NSLog("[JARVIS] reminder: %@", e.localizedDescription) } } }
    }

    /// A wake-up alarm: a loud notification at that time (every chosen day when days are given).
    func alarm(hour: Int, minute: Int, label: String, days: String) -> String {
        var dc = DateComponents(); dc.hour = hour; dc.minute = minute
        let cal = Calendar.current
        let when = cal.nextDate(after: Date(), matching: dc, matchingPolicy: .nextTime) ?? Date().addingTimeInterval(60)
        let ds = days.lowercased()
        let names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        let chosen = names.enumerated().filter { ds.contains($0.element) }.map { $0.offset + 1 }
        let item: [String: Any] = ["id": "alarm-\(hour)-\(minute)-\(Int(Date().timeIntervalSince1970))", "at": when.timeIntervalSince1970 * 1000, "kind": "alarm",
                                   "text": label, "repeat": chosen.count == 7 ? "daily" : chosen == [2, 3, 4, 5, 6] ? "weekdays" : ""]
        if chosen.isEmpty || chosen.count == 7 || chosen == [2, 3, 4, 5, 6] { _ = add(JSBridge.json(item)); return "notification" }
        for wd in chosen {                                              // particular days: one weekly alarm each
            var dcw = dc; dcw.weekday = wd
            let t = cal.nextDate(after: Date(), matching: dcw, matchingPolicy: .nextTime) ?? when
            var it = item; it["id"] = "\(item["id"]!)-\(wd)"; it["at"] = t.timeIntervalSince1970 * 1000; it["repeat"] = "weekly"
            _ = add(JSBridge.json(it))
        }
        return "notification"
    }

    func requestPermission(_ done: @escaping (Bool) -> Void) {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in DispatchQueue.main.async { done(ok) } }
    }
    func authorized(_ done: @escaping (Bool) -> Void) {
        center.getNotificationSettings { s in DispatchQueue.main.async { done(s.authorizationStatus == .authorized || s.authorizationStatus == .provisional) } }
    }

    // ---- delegate: rang while Jarvis is open (he says it), or tapped / snoozed from the notification
    @objc(userNotificationCenter:willPresentNotification:withCompletionHandler:)
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        if let item = n.request.content.userInfo["item"] as? String {
            onFire(item, true)
            done([.banner, .list])                                       // Jarvis says it, so no extra sound
        } else { done([.banner, .sound]) }
    }
    @objc(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:)
    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        defer { done() }
        guard let json = r.notification.request.content.userInfo["item"] as? String, var item = JSBridge.parse(json) as? [String: Any] else { return }
        switch r.actionIdentifier {
        case "snooze":
            item["id"] = "\(Reminders.id(item))-snooze"; item["repeat"] = ""; item["at"] = Date().timeIntervalSince1970 * 1000 + 600_000
            _ = add(JSBridge.json(item))
        case "done":
            break
        default:
            if (item["kind"] as? String) == "briefing" { onFire(json, true) }   // tapped "Good morning": he reads the briefing
        }
    }
}
