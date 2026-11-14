import { describe, expect, it } from "vite-plus/test";

import { exerciseLibrary, libraryIds } from "./exercise-library.ts";
import { equipmentFromName, HEVY_LIBRARY, suggestExercises } from "./hevy-exercises.ts";

describe("HEVY_LIBRARY", () => {
  it("maps every Hevy name to an exercise the bundled library has", () => {
    const ids = new Set(libraryIds());
    const missing = Object.entries(HEVY_LIBRARY).filter(([, id]) => !ids.has(id));
    expect(missing).toEqual([]);
    expect(Object.keys(HEVY_LIBRARY).length).toBeGreaterThan(150);
  });
});

describe("equipmentFromName", () => {
  it("reads the equipment in Hevy's brackets", () => {
    expect(equipmentFromName("Landmine Press (Barbell)")).toBe("barbell");
    expect(equipmentFromName("Row (Smith Machine)")).toBe("machine");
    expect(equipmentFromName("Curl (Cable)")).toBe("cable");
    expect(equipmentFromName("Pull Up (Weighted)")).toBe("none");
    expect(equipmentFromName("Landmine Press")).toBe("other");
  });
});

describe("suggestExercises", () => {
  const library = exerciseLibrary();

  it("puts the closest library names first", () => {
    expect(
      suggestExercises("Chest Supported Machine Row", library).map(({ name }) => name),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/row/i)]));
    expect(suggestExercises("Bench Press (Barbell)", library).map(({ name }) => name)).toContain(
      "Barbell Bench Press - Medium Grip",
    );
  });

  it("suggests nothing for a name that shares no word with any exercise", () => {
    expect(suggestExercises("Zzyzx", library)).toEqual([]);
  });

  it("gives at most the number asked for", () => {
    expect(suggestExercises("Press", library, 5)).toHaveLength(5);
  });
});
