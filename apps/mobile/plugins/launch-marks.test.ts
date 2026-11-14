import { describe, expect, it } from "vite-plus/test";

import { addLaunchMarks } from "./launch-marks";

// ios/HelloWorld/AppDelegate.swift from expo-template-bare-minimum@sdk-58 (58.0.34), which
// `expo prebuild` copies.
const TEMPLATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // The window is created and React Native is started by \`SceneDelegate\` under the
    // scene-based life cycle (required by the iOS 27 SDK).
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

describe("addLaunchMarks", () => {
  it("records main() and both ends of didFinishLaunching in Expo's app delegate", () => {
    expect(addLaunchMarks(TEMPLATE)).toBe(`internal import Expo
internal import SvettNative
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  static func main() {
    LaunchMarks.mainStarted()
    _ = UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
  }

  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    LaunchMarks.finishLaunchingStarted()
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // The window is created and React Native is started by \`SceneDelegate\` under the
    // scene-based life cycle (required by the iOS 27 SDK).
    let launched = super.application(application, didFinishLaunchingWithOptions: launchOptions)
    LaunchMarks.finishLaunchingEnded()
    return launched
  }
}
`);
  });

  it("changes nothing in an app delegate that already holds every mark", () => {
    const once = addLaunchMarks(TEMPLATE);
    expect(addLaunchMarks(once)).toBe(once);
  });

  it("refuses an app delegate that holds only some of the marks", () => {
    const once = addLaunchMarks(TEMPLATE);
    const withoutEnd = once
      .replace("    LaunchMarks.finishLaunchingEnded()\n", "")
      .replace(
        "    let launched = super.application(application, didFinishLaunchingWithOptions: launchOptions)\n",
        "",
      )
      .replace(
        "    return launched\n",
        "    return super.application(application, didFinishLaunchingWithOptions: launchOptions)\n",
      );
    expect(() => addLaunchMarks(withoutEnd)).toThrow(
      "launch-marks: AppDelegate.swift holds only part of the launch marks, without the end of " +
        "didFinishLaunching, with 2 LaunchMarks calls instead of 3. Delete apps/mobile/ios and " +
        "run the prebuild again.",
    );
    const withoutMain = once.replace(/  static func main\(\) \{\n[^}]*\}\n\n/, "");
    expect(() => addLaunchMarks(withoutMain)).toThrow("without main(), with 2 LaunchMarks calls");
    expect(() => addLaunchMarks(once.replace("internal import SvettNative\n", ""))).toThrow(
      "without the SvettNative import.",
    );
    const moved = once
      .replace("    LaunchMarks.finishLaunchingStarted()\n", "")
      .replace(
        "    reactNativeFactory = factory\n",
        "    reactNativeFactory = factory\n    LaunchMarks.finishLaunchingStarted()\n",
      );
    expect(() => addLaunchMarks(moved)).toThrow("without the start of didFinishLaunching.");
    expect(() =>
      addLaunchMarks(
        once.replace(
          "return launched\n",
          "LaunchMarks.finishLaunchingEnded()\n    return launched\n",
        ),
      ),
    ).toThrow("with 4 LaunchMarks calls instead of 3");
  });

  it("refuses an app delegate with one mark and nothing else from the plugin", () => {
    expect(() =>
      addLaunchMarks(
        TEMPLATE.replace(
          "    let delegate",
          "    LaunchMarks.finishLaunchingStarted()\n    let delegate",
        ),
      ),
    ).toThrow("without the SvettNative import, main(), the end of didFinishLaunching");
  });

  it("stops the prebuild when the template no longer has a place for a mark", () => {
    expect(() => addLaunchMarks(TEMPLATE.replace("@main\n", ""))).toThrow(
      "launch-marks: AppDelegate.swift has no match",
    );
    expect(() =>
      addLaunchMarks(TEMPLATE.replace("return super.application", "super.application")),
    ).toThrow("launch-marks: AppDelegate.swift has no match");
  });
});
