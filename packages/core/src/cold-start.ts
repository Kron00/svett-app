/** The moments of a launch the app records on its way to the Train tab's routine list. */
export const LAUNCH_STEPS = [
  "script",
  "opened",
  "migrated",
  "seeded",
  "screen",
  "train",
  "queried",
  "shown",
] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];

const STEP_NAMES: Readonly<Record<LaunchStep, string>> = {
  script: "JavaScript started",
  screen: "first screen drawn",
  train: "Train tab opened",
  opened: "database open",
  migrated: "migrations checked",
  seeded: "library checked",
  queried: "routines read",
  shown: "routine list drawn",
};

export interface ColdStart {
  /** Milliseconds from the process start to the first frame that showed the routine list. */
  readonly shownMs: number;
  /**
   * Milliseconds between the first screen and the Train tab opening. A person taps the tab, and
   * the proof script sends a link, so this time is theirs, not svett's.
   */
  readonly waitMs: number;
  /** `shownMs` without `waitMs`: svett's own share, which the 2 second target judges. */
  readonly ownMs: number;
  /** Each recorded step, in milliseconds since the process started, earliest first. */
  readonly steps: ReadonlyArray<{ readonly step: LaunchStep; readonly ms: number }>;
}

/** The cold start so far, or null until the routine list has been drawn. */
export const coldStart = (
  launchedAt: number,
  marks: ReadonlyMap<LaunchStep, number>,
): ColdStart | null => {
  const shown = marks.get("shown");
  if (shown === undefined) return null;
  const since = (at: number) => Math.round(at - launchedAt);
  const screen = marks.get("screen");
  const train = marks.get("train");
  const waitMs =
    screen === undefined || train === undefined ? 0 : Math.max(0, Math.round(train - screen));
  const shownMs = since(shown);
  return {
    shownMs,
    waitMs,
    ownMs: shownMs - waitMs,
    steps: LAUNCH_STEPS.flatMap((step) => {
      const at = marks.get(step);
      return at === undefined ? [] : [{ step, ms: since(at) }];
    }).sort((a, b) => a.ms - b.ms),
  };
};

/** One line for the screen and the proof, such as "svett's own cold start: 640 ms. ...". */
export const coldStartText = ({ shownMs, waitMs, ownMs, steps }: ColdStart): string =>
  `svett's own cold start: ${ownMs} ms. Routine list drawn ${shownMs} ms after launch, ` +
  `less ${waitMs} ms waiting for the Train tab. Steps since launch: ` +
  `${steps.map(({ step, ms }) => `${STEP_NAMES[step]} ${ms}`).join(", ")} ms.`;
