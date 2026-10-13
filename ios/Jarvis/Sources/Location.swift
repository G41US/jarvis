import CoreLocation
import UIKit

/// Where the phone is: the map and navigation (the page's navigator.geolocation comes from here), "where did I park",
/// SOS, and shift mileage (port of ShiftTracker.java), which keeps counting with Jarvis in the background.
final class Location: NSObject, CLLocationManagerDelegate {
    private let mgr = CLLocationManager()
    private let bridge: JSBridge
    private var watchers: Set<Int> = [], once: Set<Int> = []
    private var fresh: [(CLLocation?) -> Void] = []
    private(set) var lastGood: CLLocation?
    private var shiftLast: CLLocation?
    private let d = UserDefaults.standard
    var onAuth: () -> Void = {}

    init(bridge: JSBridge) {
        self.bridge = bridge
        super.init()
        mgr.delegate = self
        mgr.desiredAccuracy = kCLLocationAccuracyBest
        mgr.activityType = .automotiveNavigation
        mgr.pausesLocationUpdatesAutomatically = false
        if shiftActive { DispatchQueue.main.async { self.update() } }
    }

    var status: CLAuthorizationStatus { mgr.authorizationStatus }
    var allowed: Bool { status == .authorizedWhenInUse || status == .authorizedAlways }
    func ask() { if status == .notDetermined { mgr.requestWhenInUseAuthorization() } }

    /// Runs GPS while anyone needs it; in the background only during a shift or while the map is following you.
    private func update() {
        let need = !watchers.isEmpty || !once.isEmpty || !fresh.isEmpty || shiftActive
        guard need else { mgr.stopUpdatingLocation(); return }
        if !allowed { ask(); return }
        let background = shiftActive || !watchers.isEmpty
        if background && Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") != nil {
            mgr.allowsBackgroundLocationUpdates = true
            mgr.showsBackgroundLocationIndicator = true
        } else { mgr.allowsBackgroundLocationUpdates = false }
        mgr.distanceFilter = watchers.isEmpty && !shiftActive ? 10 : kCLDistanceFilterNone
        mgr.startUpdatingLocation()
    }

    // ---- the page's navigator.geolocation
    func geoStart(_ id: Int, once single: Bool) {
        if !allowed && status != .notDetermined { bridge.js("window.__jvGeo&&window.__jvGeo(\(id),null,1)"); return }
        if single {
            if let l = lastGood, -l.timestamp.timeIntervalSinceNow < 10 { send(id, l); return }
            once.insert(id)
        } else {
            watchers.insert(id)
            if let l = lastGood, -l.timestamp.timeIntervalSinceNow < 30 { send(id, l) }
        }
        update()
    }
    func geoStop(_ id: Int) { watchers.remove(id); once.remove(id); update() }

    private func send(_ id: Int, _ l: CLLocation) {
        let p: [String: Any] = ["lat": l.coordinate.latitude, "lon": l.coordinate.longitude, "acc": l.horizontalAccuracy,
                                "heading": l.course, "speed": l.speed, "ts": l.timestamp.timeIntervalSince1970 * 1000]
        bridge.js("window.__jvGeo&&window.__jvGeo(\(id),\(JSBridge.json(p)))")
    }

    // ---- delegate
    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        onAuth()
        if allowed { update() }
        else if status == .denied || status == .restricted {
            for id in watchers.union(once) { bridge.js("window.__jvGeo&&window.__jvGeo(\(id),null,1)") }
            once.removeAll()
            let f = fresh; fresh.removeAll(); f.forEach { $0(nil) }
        }
    }
    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        if (error as NSError).code == CLError.denied.rawValue { locationManagerDidChangeAuthorization(m) }
    }
    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        for l in locs where l.horizontalAccuracy >= 0 {
            if l.horizontalAccuracy <= 150 || lastGood == nil { lastGood = l }
            for id in watchers { send(id, l) }
            for id in once { send(id, l) }
            once.removeAll()
            if l.horizontalAccuracy < 150 { let f = fresh; fresh.removeAll(); f.forEach { $0(l) } }
            mileage(l)
        }
        if watchers.isEmpty && once.isEmpty && fresh.isEmpty && !shiftActive { mgr.stopUpdatingLocation() }
    }

    // ---- last known place: {lat, lon, acc, age_s} or {}
    func lastJSON() -> String {
        guard let l = lastGood ?? mgr.location else { return "{}" }
        return JSBridge.json(["lat": l.coordinate.latitude, "lon": l.coordinate.longitude, "acc": Int(l.horizontalAccuracy.rounded()),
                              "age_s": max(0, Int(-l.timestamp.timeIntervalSinceNow))])
    }
    /// A fix no older than a minute (waits up to timeoutMs for one).
    func freshJSON(timeoutMs: Int, done: @escaping (String) -> Void) {
        if let l = lastGood ?? mgr.location, -l.timestamp.timeIntervalSinceNow < 60, l.horizontalAccuracy < 100 { done(lastJSON()); return }
        if !allowed { done(lastJSON()); return }
        var finished = false
        let finish: (CLLocation?) -> Void = { [weak self] _ in if finished { return }; finished = true; done(self?.lastJSON() ?? "{}") }
        fresh.append(finish)
        update()
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(max(1000, min(timeoutMs, 15000)))) { [weak self] in
            finish(nil); self?.update()
        }
    }
    /// A map link with accuracy, for SOS and "share my location".
    func placeText(done: @escaping (String) -> Void) {
        freshJSON(timeoutMs: 8000) { s in
            guard let o = JSBridge.parse(s) as? [String: Any], let lat = o["lat"] as? Double, let lon = o["lon"] as? Double else { done("Location unavailable (GPS off)."); return }
            let acc = (o["acc"] as? Int) ?? 0, age = (o["age_s"] as? Int) ?? 0
            done(String(format: "https://maps.google.com/?q=%.6f,%.6f", lat, lon) + " (within \(max(5, acc)) m" + (age > 120 ? ", \(age / 60) min ago" : "") + ")")
        }
    }

    // ---- shifts and mileage
    var shiftActive: Bool { d.bool(forKey: "shift.active") }
    func shiftStatus() -> String {
        JSBridge.json(["active": shiftActive, "start": d.double(forKey: "shift.start"), "meters": Int(d.double(forKey: "shift.meters").rounded()),
                       "moving_ms": d.double(forKey: "shift.moving_ms"), "gps": lastGood.map { -$0.timestamp.timeIntervalSinceNow < 120 } ?? false])
    }
    func shiftStart() -> String {
        if !allowed { ask(); if status != .notDetermined { return "{\"error\":\"location\"}" } }
        if !shiftActive {
            d.set(true, forKey: "shift.active"); d.set(Date().timeIntervalSince1970 * 1000, forKey: "shift.start")
            d.set(0.0, forKey: "shift.meters"); d.set(0.0, forKey: "shift.moving_ms")
        }
        shiftLast = nil
        update()
        return shiftStatus()
    }
    func shiftEnd() -> String {
        guard shiftActive else { return "{\"error\":\"none\"}" }
        let trip: [String: Any] = ["start": d.double(forKey: "shift.start"), "end": Date().timeIntervalSince1970 * 1000,
                                   "meters": Int(d.double(forKey: "shift.meters").rounded()), "moving_ms": d.double(forKey: "shift.moving_ms")]
        var log = (JSBridge.parse(d.string(forKey: "shift.trips") ?? "[]") as? [Any]) ?? []
        log.append(trip)
        if log.count > 3000 { log.removeFirst(log.count - 3000) }
        d.set(JSBridge.json(log), forKey: "shift.trips")
        d.set(false, forKey: "shift.active")
        shiftLast = nil
        update()
        return JSBridge.json(trip)
    }
    func trips() -> String { d.string(forKey: "shift.trips") ?? "[]" }

    private func mileage(_ l: CLLocation) {
        guard shiftActive, l.horizontalAccuracy >= 0, l.horizontalAccuracy <= 60 else { return }
        if let last = shiftLast {
            let dist = l.distance(from: last), dt = max(0.001, l.timestamp.timeIntervalSince(last.timestamp))
            let speed = dist / dt
            let noise = max(10, l.horizontalAccuracy + last.horizontalAccuracy) * 0.6
            if speed > 70 { return }                                   // a GPS jump (over 155 mph): skip this fix
            if dist < noise { return }                                  // jitter while parked: keep the old anchor
            d.set(d.double(forKey: "shift.meters") + dist, forKey: "shift.meters")
            if speed > 2 && dt < 120 { d.set(d.double(forKey: "shift.moving_ms") + dt * 1000, forKey: "shift.moving_ms") }
        }
        shiftLast = l
    }
}
