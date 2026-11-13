// Writes a deterministic test database: about 300 strength workouts and 6,000 sets over two years.
// Usage: pnpm fixture [--seed <n>] [--out <path>]
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { buildFixture, FIXTURE_SEED, openNodeDatabase } from "@svett/core/node";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: String(FIXTURE_SEED) },
    out: {
      type: "string",
      default: new URL("../.fixtures/svett-fixture.db", import.meta.url).pathname,
    },
  },
});

const out = resolve(values.out);
const partial = `${out}.partial`;
mkdirSync(dirname(out), { recursive: true });
rmSync(partial, { force: true });

const { database, driver } = openNodeDatabase(partial);
const summary = await buildFixture(driver, Number(values.seed));
database.close();
renameSync(partial, out);

console.log(out);
console.log(JSON.stringify({ seed: Number(values.seed), ...summary }, null, 2));
