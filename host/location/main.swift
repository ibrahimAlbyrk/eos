// eos-location — prints this Mac's location once as one JSON line, asking macOS
// for permission first when it hasn't been decided. The Eos app launches it, so
// macOS attributes the request to Eos (its usage string, its Location Services
// row). Chromium's navigator.geolocation never reaches CoreLocation inside
// Electron (no system-permission request is made), which is why this exists.
//
//   eos-location [timeoutSeconds]
//   → {"lat":…,"lon":…,"accuracy":…,"at":<ms>}
//   → {"error":"denied|restricted|disabled|timeout|unavailable","message":"…"}

import CoreLocation
import Foundation

final class Locator: NSObject, CLLocationManagerDelegate {
  private let manager = CLLocationManager()
  private var asked = false
  private var updating = false
  private var done = false

  func start(timeout: TimeInterval) {
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
      self?.finish(["error": "timeout", "message": "no location within \(Int(timeout)) s"])
    }
    guard CLLocationManager.locationServicesEnabled() else {
      return finish(["error": "disabled", "message": "Location Services are off"])
    }
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    // The delegate is told the current status right away, and again after the prompt.
    manager.delegate = self
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    switch manager.authorizationStatus {
    case .notDetermined:
      if !asked {
        asked = true
        manager.requestWhenInUseAuthorization()
      }
    case .denied:
      finish(["error": "denied", "message": "location access denied"])
    case .restricted:
      finish(["error": "restricted", "message": "location access restricted"])
    default:
      if !updating {
        updating = true
        manager.startUpdatingLocation()
      }
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let fix = locations.last, fix.horizontalAccuracy >= 0 else { return }
    finish([
      "lat": fix.coordinate.latitude,
      "lon": fix.coordinate.longitude,
      "accuracy": fix.horizontalAccuracy,
      "at": Int(fix.timestamp.timeIntervalSince1970 * 1000),
    ])
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    let code = (error as? CLError)?.code
    // Transient while CoreLocation is still working on a fix.
    if code == .locationUnknown { return }
    finish(["error": code == .denied ? "denied" : "unavailable", "message": error.localizedDescription])
  }

  private func finish(_ result: [String: Any]) {
    guard !done else { return }
    done = true
    manager.stopUpdatingLocation()
    let data = (try? JSONSerialization.data(withJSONObject: result)) ?? Data(#"{"error":"unavailable"}"#.utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
  }
}

let timeout = CommandLine.arguments.dropFirst().first.flatMap(TimeInterval.init) ?? 25
let locator = Locator()
locator.start(timeout: max(1, timeout))
RunLoop.main.run()
