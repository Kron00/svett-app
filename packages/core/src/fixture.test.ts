import { describe, expect, it } from "vite-plus/test";

import { buildFixture, FIXTURE_SEED } from "./fixture.ts";
import { openNodeDatabase } from "./node-sqlite.ts";

describe("buildFixture", () => {
  it("builds two years of training with the same rows for the same seed", async () => {
    const first = await buildFixture(openNodeDatabase().driver);
    const second = await buildFixture(openNodeDatabase().driver);
    expect(second).toEqual(first);
    expect(first).toMatchInlineSnapshot(`
      {
        "checksum": "9b46552aea5d4eb65318e936d6833856df7734f4ce48b13e467c15eb28718d39",
        "exercises": 876,
        "measurements": 155,
        "routines": 3,
        "sets": 6023,
        "workouts": 300,
      }
    `);
  });

  it("builds different rows for a different seed", async () => {
    const other = await buildFixture(openNodeDatabase().driver, FIXTURE_SEED + 1);
    const usual = await buildFixture(openNodeDatabase().driver);
    expect(other.checksum).not.toBe(usual.checksum);
  });
});
