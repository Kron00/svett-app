import { Effect, Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decodeHevyFile, wallTimeAsUtc } from "./hevy-file.ts";
import { HEVY_LIBRARY } from "./hevy-exercises.ts";
import { exerciseNames, hevyImport } from "./hevy-import.ts";
import { syntheticHevyCsv } from "./hevy-synthetic.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { TransferRepository } from "./repositories/transfer.ts";
import { openTestDatabase } from "./test-database.ts";
import { isNothingToImport } from "./transfer.ts";

const file = Result.getOrThrow(decodeHevyFile(syntheticHevyCsv(300), wallTimeAsUtc));

describe("syntheticHevyCsv", () => {
  it("writes 300 workouts in Hevy's layout, with about 6,000 sets", () => {
    expect(file.workouts).toHaveLength(300);
    expect(
      file.workouts.flatMap((workout) => workout.exercises.flatMap((each) => each.sets)),
    ).toHaveLength(300 * 5 * 4);
    expect(syntheticHevyCsv(300)).toBe(syntheticHevyCsv(300));
  });

  it("names only exercises the library knows, so the import asks nothing", () => {
    expect(exerciseNames(file).filter((name) => HEVY_LIBRARY[name] === undefined)).toEqual([]);
  });

  it("imports as 300 workouts, and a second import of it adds nothing", async () => {
    const database = openTestDatabase();
    const transfers = <A, E>(
      body: (repository: typeof TransferRepository.Service) => Effect.Effect<A, E>,
    ) => database.runtime.runPromise(Effect.flatMap(Effect.service(TransferRepository), body));
    const applied = await transfers((repository) => repository.applyImport(hevyImport(file), []));
    expect(Option.isSome(applied)).toBe(true);
    const counts = await database.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.counts),
    );
    expect(counts).toMatchObject({ activities: 300, sets: 6000 });
    const again = await transfers((repository) => repository.previewImport(hevyImport(file)));
    expect(isNothingToImport(again)).toBe(true);
  }, 60_000);
});
