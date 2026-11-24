import EosRemoteKit
import SwiftUI
import UIKit
import UserNotifications

// Registers for push at launch and routes a tapped push to Needs you of the Mac it came from
// (07 §4.6, §4.8). A build without the push entitlement fails to register: Settings says so.
final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            DispatchQueue.main.async {
                if granted { application.registerForRemoteNotifications() } else { PushRegistration.shared.denied() }
            }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistration.shared.registered(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistration.shared.failed()
    }

    // A push that lands while the app is open still shows as a banner.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler:
                                                @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .badge, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let link = PushRouting.link(for: response.notification.request.content.userInfo, in: DeviceStore().load())
        DispatchQueue.main.async {
            if let link { NotificationCenter.default.post(name: .eosOpenLink, object: link) }
        }
        completionHandler()
    }
}

extension Notification.Name {
    /// An `eos://` link to open from inside the app (a tapped push).
    static let eosOpenLink = Notification.Name("eos.openLink")
}
