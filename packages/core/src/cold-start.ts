/**
 * The moments of a launch the app records on its way to the Train tab's routine list, in the
 * order they happen when nothing overlaps. Native code records the first four, React Native
 * the two bundle steps, and JavaScript the rest.
 */
export const LAUNCH_STEPS = [
  "process",
  "main",
  "finishing",
  "finished",
  "bundle",
  "script",
  "bundled",
  "opened",
  "migrated",
  "seeded",
  "screen",
  "train",
  "queried",
  "shown",
  "locationStopped",
] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];

const STEP_NAMES: Readonly<Record<LaunchStep, string>> = {
  process: "process start",
  main: "main()",
  finishing: "didFinishLaunching start",
  finished: "didFinishLaunching end",
  bundle: "bundle start",
  script: "JavaScript started",
  bundled: "bundle end",
  opened: "database open",
  migrated: "migrations checked",
  seeded: "library checked",
  screen: "first screen drawn",
  train: "Train tab opened",
  queried: "routines read",
  shown: "routine list drawn",
  locationStopped: "leftover location task stopped",
};

/** The step a cold start is timed from. */
export type LaunchOrigin = "process" | "main";

/**
 * iOS may prewarm svett: it starts the process and runs it up to main() long before anyone
 * taps the icon, and sets ActivePrewarm in its environment. Timing such a launch from the
 * process start would count the time the phone waited for the tap, so it is timed from main()
 * instead. Without main() on record, the process start is all there is, and the text says so.
 */
export const launchOrigin = (
  marks: ReadonlyMap<LaunchStep, number>,
  prewarmed: boolean,
): LaunchOrigin => (prewarmed && marks.has("main") ? "main" : "process");

const ORIGIN_RULE = (origin: LaunchOrigin, prewarmed: boolean): string => {
  if (origin === "main") {
    return "Timed from main(), because iOS prewarmed this launch and started the process before the tap.";
  }
  return prewarmed
    ? "Timed from the process start, which overstates it, because iOS prewarmed this launch and main() was not recorded."
    : "Timed from the process start, because iOS did not prewarm this launch.";
};

export interface ColdStart {
  readonly origin: LaunchOrigin;
  readonly prewarmed: boolean;
  /** Milliseconds from the origin to the first frame that showed the routine list. */
  readonly shownMs: number;
  /**
   * Milliseconds between the first screen and the Train tab opening. A person taps the tab, and
   * the proof script sends a link, so this time is theirs, not svett's.
   */
  readonly waitMs: number;
  /** `shownMs` without `waitMs`: svett's own share, which the 2 second target judges. */
  readonly ownMs: number;
  /** Each recorded step, in milliseconds since the origin, earliest first. */
  readonly steps: ReadonlyArray<{ readonly step: LaunchStep; readonly ms: number }>;
}

/**
 * The cold start so far, or null until the routine list has been drawn. `marks` holds each
 * step's time in milliseconds since 1970.
 */
export const coldStart = (
  marks: ReadonlyMap<LaunchStep, number>,
  prewarmed: boolean,
): ColdStart | null => {
  const origin = launchOrigin(marks, prewarmed);
  const from = marks.get(origin);
  const shown = marks.get("shown");
  if (from === undefined || shown === undefined) return null;
  const since = (at: number) => Math.round(at - from);
  const screen = marks.get("screen");
  const train = marks.get("train");
  const waitMs =
    screen === undefined || train === undefined ? 0 : Math.max(0, Math.round(train - screen));
  const shownMs = since(shown);
  return {
    origin,
    prewarmed,
    shownMs,
    waitMs,
    ownMs: shownMs - waitMs,
    steps: LAUNCH_STEPS.flatMap((step) => {
      const at = marks.get(step);
      return at === undefined ? [] : [{ step, ms: since(at) }];
    }).sort((a, b) => a.ms - b.ms),
  };
};

/**
 * One paragraph for the screen and the proof. It opens with "svett's own cold start: <n> ms",
 * and ends with "Steps since <origin>: <step> <ms>, ... ms." so scripts/sim/startup.sh can read
 * every step.
 */
export const coldStartText = ({ origin, prewarmed, waitMs, ownMs, steps }: ColdStart): string =>
  `svett's own cold start: ${ownMs} ms. The 2 second target judges this number: from ` +
  `${STEP_NAMES[origin]} to the first frame with the Train tab's routine list, less ${waitMs} ms ` +
  `waiting for the Train tab, because a person opens that tab. ${ORIGIN_RULE(origin, prewarmed)} ` +
  `Steps since ${STEP_NAMES[origin]}: ` +
  `${steps.map(({ step, ms }) => `${STEP_NAMES[step]} ${ms}`).join(", ")} ms.`;

/** React Native's own startup timing, as `performance.rnStartupTiming` gives it. */
export interface ReactNativeStartupTiming {
  readonly executeJavaScriptBundleEntryPointStart?: number | null;
  readonly endTime?: number | null;
}

/**
 * The bundle steps from React Native's startup timing, in milliseconds since 1970.
 * `performanceOrigin` is `Date.now() - performance.now()`, because React Native times them on
 * `performance.now()`'s clock.
 */
export const reactNativeSteps = (
  timing: ReactNativeStartupTiming | undefined,
  performanceOrigin: number,
): ReadonlyArray<readonly [LaunchStep, number]> =>
  (
    [
      ["bundle", timing?.executeJavaScriptBundleEntryPointStart],
      ["bundled", timing?.endTime],
    ] as const
  ).flatMap(([step, at]) =>
    typeof at === "number" && Number.isFinite(at) ? [[step, performanceOrigin + at] as const] : [],
  );
