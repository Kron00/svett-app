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

  it("changes nothing the second time", () => {
    const once = addLaunchMarks(TEMPLATE);
    expect(addLaunchMarks(once)).toBe(once);
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
