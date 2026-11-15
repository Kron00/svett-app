import Foundation

/// The moments of a launch before JavaScript runs, in milliseconds since 1970. The app delegate
/// records them through the config plugin in apps/mobile/plugins/launch-marks.ts, because no
/// Expo module runs early enough to see main() or the start of didFinishLaunching.
public enum LaunchMarks {
    private static var recorded: [String: Double] = [:]

    /// iOS sets ActivePrewarm when it started the process ahead of the tap.
    public static let prewarmed = ProcessInfo.processInfo.environment["ActivePrewarm"] == "1"

    public static func mainStarted() { mark("main") }
    public static func finishLaunchingStarted() { mark("finishing") }
    public static func finishLaunchingEnded() { mark("finished") }

    /// Each recorded step by name. The main thread writes them before React Native starts, and
    /// JavaScript reads them later.
    static var marks: [String: Double] { recorded }

    private static func mark(_ step: String) {
        if recorded[step] == nil { recorded[step] = Date().timeIntervalSince1970 * 1000 }
    }
}
