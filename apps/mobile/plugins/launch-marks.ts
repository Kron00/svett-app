import { type ConfigPlugin, withAppDelegate } from "expo/config-plugins";

const MAIN = `  static func main() {
    LaunchMarks.mainStarted()
    _ = UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
  }

`;

const insert = (contents: string, anchor: RegExp, text: (match: string) => string) => {
  const found = contents.match(anchor);
  if (found === null) {
    throw new Error(`launch-marks: AppDelegate.swift has no match for ${anchor}`);
  }
  return contents.replace(anchor, text(found[0]));
};

/**
 * Makes the app delegate record main() and the start and end of didFinishLaunching in
 * SvettNative's LaunchMarks. It throws when Expo's template changed shape, so a prebuild never
 * quietly drops a mark.
 */
export const addLaunchMarks = (contents: string): string => {
  if (contents.includes("LaunchMarks.")) return contents;
  let next = insert(contents, /^internal import Expo\n/m, (line) => `${line}internal import SvettNative\n`);
  // A class marked @main that declares main() runs it in place of UIApplicationMain alone.
  next = insert(next, /^@main\nclass AppDelegate\b[^{]*\{\n/m, (head) => `${head}${MAIN}`);
  next = insert(
    next,
    /didFinishLaunchingWithOptions launchOptions: [^{]*\{\n/,
    (head) => `${head}    LaunchMarks.finishLaunchingStarted()\n`,
  );
  return insert(
    next,
    /^( *)return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)\n/m,
    (line) => {
      const indent = line.slice(0, line.indexOf("return"));
      return (
        `${indent}let launched = super.application(application, didFinishLaunchingWithOptions: launchOptions)\n` +
        `${indent}LaunchMarks.finishLaunchingEnded()\n` +
        `${indent}return launched\n`
      );
    },
  );
};

const withLaunchMarks: ConfigPlugin = (config) =>
  withAppDelegate(config, (delegate) => {
    if (delegate.modResults.language !== "swift") {
      throw new Error("launch-marks: expected a Swift AppDelegate");
    }
    delegate.modResults.contents = addLaunchMarks(delegate.modResults.contents);
    return delegate;
  });

export default withLaunchMarks;
