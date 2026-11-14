import { Context, Effect, Layer } from "effect";

import { importedId } from "../ids.ts";
import {
  type BarsAndPlates,
  type BarsAndPlatesByUnit,
  DEFAULT_BARS_AND_PLATES,
} from "../plates.ts";
import { GearId } from "../schema.ts";
import { Sql } from "../sql.ts";
import { currentTime, putRows, selectRows, TABLES } from "../table.ts";
import type { WeightUnit } from "../weight-unit.ts";

/**
 * Each unit has one row with the same ID on every device, so an import or sync of your plates
 * and bars replaces them rather than adding a second set.
 */
export const gearId = (unit: WeightUnit): GearId =>
  GearId.make(importedId(TABLES.gear.name, "svett", unit));

const makeGearRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const run = <A, E>(effect: Effect.Effect<A, E, Sql>) => Effect.provideService(effect, Sql, sql);
  return {
    /** Your plates and bars in each unit. A unit you never changed has a commercial gym's. */
    all: run(
      Effect.map(selectRows(TABLES.gear), (rows): BarsAndPlatesByUnit => {
        const of = (unit: WeightUnit): BarsAndPlates => {
          const row = rows.find((gear) => gear.unit === unit);
          return row === undefined
            ? DEFAULT_BARS_AND_PLATES[unit]
            : { plates: row.plates, bars: row.bars };
        };
        return { kg: of("kg"), lb: of("lb") };
      }),
    ),
    /** Saves your plates and bars in `unit`. */
    save: (unit: WeightUnit, { plates, bars }: BarsAndPlates) =>
      run(
        Effect.gen(function* () {
          yield* putRows(TABLES.gear, [
            {
              id: gearId(unit),
              unit,
              plates,
              bars,
              updatedAt: yield* currentTime,
              deletedAt: null,
            },
          ]);
        }),
      ),
  };
});

/** The only writer of the gear table: your plates and bars. */
export class GearRepository extends Context.Service<
  GearRepository,
  Effect.Success<typeof makeGearRepository>
>()("svett/GearRepository") {
  static readonly layer = Layer.effect(GearRepository, makeGearRepository);
}
