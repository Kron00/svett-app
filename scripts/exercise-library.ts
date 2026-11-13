// Regenerates packages/core/src/exercise-library.json from free-exercise-db (Unlicense).
// Usage: node scripts/exercise-library.ts && pnpm fmt
import { writeFile } from "node:fs/promises";

const COMMIT = "f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5";
const SOURCE = `https://raw.githubusercontent.com/yuhonas/free-exercise-db/${COMMIT}/dist/exercises.json`;
const OUTPUT = new URL("../packages/core/src/exercise-library.json", import.meta.url);

type Entry = {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly equipment: string | null;
  readonly primaryMuscles: ReadonlyArray<string>;
  readonly secondaryMuscles: ReadonlyArray<string>;
};

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}`);
const entries = (await response.json()) as ReadonlyArray<Entry>;

const trimmed = entries
  .map(({ id, name, category, equipment, primaryMuscles, secondaryMuscles }) => ({
    id,
    name,
    category,
    equipment,
    primaryMuscles,
    secondaryMuscles,
  }))
  .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

await writeFile(OUTPUT, `${JSON.stringify(trimmed, null, 1)}\n`);
console.log(`Wrote ${trimmed.length} exercises from free-exercise-db ${COMMIT.slice(0, 7)}`);
