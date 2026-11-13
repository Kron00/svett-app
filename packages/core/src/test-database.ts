import { Layer, ManagedRuntime } from "effect";

import { databaseLayer } from "./database.ts";
import { Ids } from "./ids.ts";
import { manualClock } from "./manual-clock.ts";
import { openNodeDatabase } from "./node-sqlite.ts";

export const T0 = Date.UTC(2026, 0, 1, 9);

/** A fresh in-memory database, migrated and seeded, with a clock that moves only when told. */
export const openTestDatabase = (seed = 1) => {
  const { database, driver } = openNodeDatabase();
  const clock = manualClock(T0);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(seed)), clock.layer),
  );
  return { database, driver, clock, runtime };
};
