import UIKit
import AppIntents

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool { true }

    func application(_ application: UIApplication, configurationForConnecting s: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let c = UISceneConfiguration(name: "Default", sessionRole: s.role)
        c.delegateClass = SceneDelegate.self
        return c
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        let w = UIWindow(windowScene: ws)
        w.rootViewController = WebViewController()
        w.overrideUserInterfaceStyle = .dark
        w.makeKeyAndVisible()
        window = w
        if !options.shortcutItems.isEmpty || UserDefaults.standard.bool(forKey: "jarvis.wakeOnOpen") {
            UserDefaults.standard.set(false, forKey: "jarvis.wakeOnOpen")
            NotificationCenter.default.post(name: .jarvisWake, object: nil)
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        if UserDefaults.standard.bool(forKey: "jarvis.wakeOnOpen") {
            UserDefaults.standard.set(false, forKey: "jarvis.wakeOnOpen")
            NotificationCenter.default.post(name: .jarvisWake, object: nil)
        }
    }
}

// ---------------------------------------------------------------------- Siri, Shortcuts and the Action Button
/// "Hey Siri, talk to Jarvis": opens Jarvis listening. (iPhone doesn't let apps listen for their own name while closed.)
struct TalkToJarvis: AppIntent {
    static var title: LocalizedStringResource = "Talk to Jarvis"
    static var description = IntentDescription("Opens Jarvis, ready to listen.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(true, forKey: "jarvis.wakeOnOpen")     // picked up when Jarvis comes on screen
        return .result()
    }
}

struct JarvisShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: TalkToJarvis(),
                    phrases: ["Talk to \(.applicationName)", "Hey \(.applicationName)", "Ask \(.applicationName)", "Open \(.applicationName) and listen"])
    }
}
