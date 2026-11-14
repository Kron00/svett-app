import { describe, expect, it } from "vite-plus/test";

import { coldStart, coldStartText, type LaunchStep, reactNativeSteps } from "./cold-start.ts";

const processStart = 1_000_000;
const marks = (entries: ReadonlyArray<readonly [LaunchStep, number]>) =>
  new Map(entries.map(([step, ms]) => [step, processStart + ms] as const));

describe("coldStart", () => {
  it("is null until the routine list has been drawn", () => {
    expect(
      coldStart(
        marks([
          ["process", 0],
          ["script", 200],
          ["queried", 700],
        ]),
        false,
      ),
    ).toBeNull();
  });

  it("times a launch from the process start, leaves out the wait for the Train tab, and lists steps by time", () => {
    const start = coldStart(
      marks([
        ["shown", 1500.6],
        ["train", 1400],
        ["queried", 1450],
        ["screen", 500],
        ["script", 210.4],
        ["process", 0],
        ["main", 80],
        ["finishing", 120],
        ["finished", 150],
        ["bundle", 190],
        ["bundled", 240],
        ["opened", 260],
        ["migrated", 270],
        ["seeded", 280],
      ]),
      false,
    );
    expect(start).toEqual({
      origin: "process",
      prewarmed: false,
      shownMs: 1501,
      waitMs: 900,
      ownMs: 601,
      steps: [
        { step: "process", ms: 0 },
        { step: "main", ms: 80 },
        { step: "finishing", ms: 120 },
        { step: "finished", ms: 150 },
        { step: "bundle", ms: 190 },
        { step: "script", ms: 210 },
        { step: "bundled", ms: 240 },
        { step: "opened", ms: 260 },
        { step: "migrated", ms: 270 },
        { step: "seeded", ms: 280 },
        { step: "screen", ms: 500 },
        { step: "train", ms: 1400 },
        { step: "queried", ms: 1450 },
        { step: "shown", ms: 1501 },
      ],
    });
    expect(coldStartText(start!)).toBe(
      "svett's own cold start: 601 ms. The 2 second target judges this number: from process " +
        "start to the first frame with the Train tab's routine list, less 900 ms waiting for the " +
        "Train tab, because a person opens that tab. Timed from the process start, because iOS " +
        "did not prewarm this launch. Steps since process start: process start 0, main() 80, " +
        "didFinishLaunching start 120, didFinishLaunching end 150, bundle start 190, JavaScript " +
        "started 210, bundle end 240, database open 260, migrations checked 270, library checked " +
        "280, first screen drawn 500, Train tab opened 1400, routines read 1450, routine list " +
        "drawn 1501 ms.",
    );
  });

  it("times a prewarmed launch from main(), so the wait for the tap does not count", () => {
    const start = coldStart(
      marks([
        ["process", 0],
        ["main", 3_600_000],
        ["script", 3_600_300],
        ["screen", 3_600_500],
        ["shown", 3_600_700],
      ]),
      true,
    );
    expect(start).toMatchObject({ origin: "main", prewarmed: true, shownMs: 700, ownMs: 700 });
    expect(start?.steps[0]).toEqual({ step: "process", ms: -3_600_000 });
    expect(coldStartText(start!)).toContain(
      "from main() to the first frame with the Train tab's routine list, less 0 ms waiting for " +
        "the Train tab, because a person opens that tab. Timed from main(), because iOS " +
        "prewarmed this launch and started the process before the tap. Steps since main(): " +
        "process start -3600000, main() 0,",
    );
  });

  it("says a prewarmed launch without main() on record is overstated", () => {
    const start = coldStart(
      marks([
        ["process", 0],
        ["shown", 900],
      ]),
      true,
    );
    expect(start).toMatchObject({ origin: "process", ownMs: 900 });
    expect(coldStartText(start!)).toContain(
      "Timed from the process start, which overstates it, because iOS prewarmed this launch " +
        "and main() was not recorded.",
    );
  });

  it("counts no wait when the Train tab opened before the first screen was drawn", () => {
    const start = coldStart(
      marks([
        ["process", 0],
        ["train", 400],
        ["screen", 450],
        ["shown", 800],
      ]),
      false,
    );
    expect(start).toMatchObject({ shownMs: 800, waitMs: 0, ownMs: 800 });
  });

  it("lists a leftover location task that the launch stopped", () => {
    const start = coldStart(
      marks([
        ["process", 0],
        ["shown", 800],
        ["locationStopped", 820],
      ]),
      false,
    );
    expect(coldStartText(start!)).toMatch(/, leftover location task stopped 820 ms\.$/);
  });
});

describe("reactNativeSteps", () => {
  it("moves React Native's bundle times onto the clock of the other steps", () => {
    expect(
      reactNativeSteps(
        { executeJavaScriptBundleEntryPointStart: 1200.4, endTime: 1450 },
        processStart,
      ),
    ).toEqual([
      ["bundle", processStart + 1200.4],
      ["bundled", processStart + 1450],
    ]);
  });

  it("leaves out a time React Native did not record", () => {
    expect(
      reactNativeSteps({ executeJavaScriptBundleEntryPointStart: 5, endTime: null }, 0),
    ).toEqual([["bundle", 5]]);
    expect(reactNativeSteps(undefined, 0)).toEqual([]);
  });
});
