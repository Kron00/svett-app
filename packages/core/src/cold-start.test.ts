import { describe, expect, it } from "vite-plus/test";

import { coldStart, coldStartText, type LaunchStep } from "./cold-start.ts";

const launchedAt = 1_000_000;
const marks = (entries: ReadonlyArray<readonly [LaunchStep, number]>) =>
  new Map(entries.map(([step, ms]) => [step, launchedAt + ms] as const));

describe("coldStart", () => {
  it("is null until the routine list has been drawn", () => {
    expect(
      coldStart(
        launchedAt,
        marks([
          ["script", 200],
          ["queried", 700],
        ]),
      ),
    ).toBeNull();
  });

  it("leaves out the wait between the first screen and the Train tab, and lists steps by time", () => {
    const start = coldStart(
      launchedAt,
      marks([
        ["shown", 1500.6],
        ["train", 1400],
        ["queried", 1450],
        ["screen", 500],
        ["script", 210.4],
        ["opened", 260],
        ["migrated", 270],
        ["seeded", 280],
      ]),
    );
    expect(start).toEqual({
      shownMs: 1501,
      waitMs: 900,
      ownMs: 601,
      steps: [
        { step: "script", ms: 210 },
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
      "svett's own cold start: 601 ms. Routine list drawn 1501 ms after launch, less 900 ms " +
        "waiting for the Train tab. Steps since launch: JavaScript started 210, database open 260, " +
        "migrations checked 270, library checked 280, first screen drawn 500, Train tab opened " +
        "1400, routines read 1450, routine list drawn 1501 ms.",
    );
  });

  it("counts no wait when the Train tab opened before the first screen was drawn", () => {
    const start = coldStart(
      launchedAt,
      marks([
        ["train", 400],
        ["screen", 450],
        ["shown", 800],
      ]),
    );
    expect(start).toMatchObject({ shownMs: 800, waitMs: 0, ownMs: 800 });
  });
});
