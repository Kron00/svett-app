import type { DatabaseSync } from "node:sqlite";

import { Layer, ManagedRuntime } from "effect";

import { databaseLayer } from "./database.ts";
import { Ids } from "./ids.ts";
import { manualClock } from "./manual-clock.ts";
import { openNodeDatabase } from "./node-sqlite.ts";
import { columnOf, TABLES } from "./table.ts";
import { PARENT, REFERENCES, TABLE_KEYS } from "./transfer.ts";

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

/** Live rows that point at a deleted row, through a parent key or a reference. */
export const pointersToDeleted = ({ database }: { readonly database: DatabaseSync }) =>
  [
    ...REFERENCES,
    ...TABLE_KEYS.flatMap((table) => {
      const parent = PARENT[table];
      return parent === null ? [] : [{ table, key: parent.key, target: parent.table }];
    }),
  ].flatMap(({ table, key, target }) =>
    database
      .prepare(
        `SELECT r.id FROM ${TABLES[table].name} r JOIN ${TABLES[target].name} t ON t.id = r.${columnOf(key)} WHERE r.deleted_at IS NULL AND t.deleted_at IS NOT NULL`,
      )
      .all()
      .map((row) => `${TABLES[table].name}/${String(row["id"])}`),
  );
