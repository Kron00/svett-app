// Writes a synthetic Hevy workout export with 300 workouts, the size the plan's import target
// names, for scripts/sim/speed.sh to time. The same count always gives the same file.
// Usage: node scripts/hevy-export.ts --out <path> [--workouts <n>]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { syntheticHevyCsv } from "@svett/core";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    workouts: { type: "string", default: "300" },
  },
});

const workouts = Number(values.workouts);
if (values.out === undefined || !Number.isInteger(workouts) || workouts < 1) {
  console.error("Usage: node scripts/hevy-export.ts --out <path> [--workouts <n>]");
  process.exit(64);
}
writeFileSync(resolve(values.out), syntheticHevyCsv(workouts));
console.log(`Wrote ${workouts} Hevy workouts to ${resolve(values.out)}`);
