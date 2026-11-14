// Prepares and judges the Apple Health and GPX import proof that scripts/sim/health.sh runs.
// Usage:
//   node scripts/health-proof.ts files <dir>              writes the sample export.zip and GPX ride
//   node scripts/health-proof.ts seed <svett.db>          a database holding one Hevy-shaped workout
//   node scripts/health-proof.ts manual-link              the svett://manual link that fills the form
//   node scripts/health-proof.ts check <svett.db> <stage> checks the database after a step
// `check` prints PASSED or FAILED for each expectation of the stage and exits 1 on any failure.
// The sample files are made up. No real Health data is ever used.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ActivityRepository,
  databaseLayer,
  heartRateSummary,
  Ids,
  ImportRepository,
  workoutsLabel,
} from "@svett/core";
import { openNodeDatabase, sampleGpx, sampleHealthZip, sampleHevyDraft } from "@svett/core/node";
import { Effect } from "effect";

export const EXPORT_FILE = "svett-health-export.zip";
export const GPX_FILE = "svett-ride.gpx";

/** What manual entry is filled with, 8 November 2026 at 17:00 UTC. */
export const MANUAL = {
  kind: "ride",
  start: Date.UTC(2026, 10, 8, 17),
  duration: "1:05:00",
  distance: "25.4",
  notes: "Coast loop",
} as const;

export const manualLink = () =>
  `svett://manual?${new URLSearchParams({
    kind: MANUAL.kind,
    start: String(MANUAL.start),
    duration: MANUAL.duration,
    distance: MANUAL.distance,
    notes: MANUAL.notes,
  }).toString()}`;

export const writeFiles = (directory: string) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, EXPORT_FILE), sampleHealthZip());
  writeFileSync(join(directory, GPX_FILE), sampleGpx());
};

/** A migrated database with one strength workout as a Hevy import leaves it. */
export const seed = async (path: string) => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  const { database, driver } = openNodeDatabase(path);
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const batch = yield* (yield* ImportRepository).create("hevy");
        return yield* (yield* ActivityRepository).create(sampleHevyDraft(batch));
      }).pipe(Effect.provide(databaseLayer(driver, Ids.layerSeeded(1)))),
    );
  } finally {
    database.close();
  }
};

export interface HealthState {
  readonly activities: number;
  readonly sets: number;
  readonly imports: Readonly<Record<"apple_health" | "gpx", number>>;
  readonly links: number;
  readonly hevyHeart: { readonly averageBpm: number; readonly maxBpm: number } | null;
  readonly manual: {
    readonly kind: string;
    readonly startedAt: number;
    readonly durationS: number;
    readonly distanceM: number | null;
    readonly notes: string;
  } | null;
}

/** Reads with plain SQL, so the app's own file is never migrated or written. */
export const readState = (path: string): HealthState => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const count = (sql: string, ...params: Array<string>) =>
      Number(database.prepare(sql).get(...params)?.["n"] ?? 0);
    const imported = (source: string) =>
      count(
        "SELECT count(*) AS n FROM import_batch WHERE deleted_at IS NULL AND status = 'applied' AND source = ?",
        source,
      );
    const hevy = database
      .prepare("SELECT id FROM activity WHERE deleted_at IS NULL AND source = 'hevy'")
      .get()?.["id"];
    const beats =
      hevy === undefined
        ? []
        : database
            .prepare(
              `SELECT s.kind, s.bpm FROM activity_sample s JOIN activity_track t ON t.id = s.activity_track_id
               WHERE t.activity_id = ? AND s.deleted_at IS NULL AND t.deleted_at IS NULL`,
            )
            .all(String(hevy))
            .map((row) => ({ kind: String(row["kind"]), bpm: Number(row["bpm"]) }));
    const manual = database
      .prepare(
        `SELECT a.kind, a.started_at, a.duration_s, a.notes, t.distance_m FROM activity a
         LEFT JOIN activity_track t ON t.activity_id = a.id AND t.deleted_at IS NULL
         WHERE a.deleted_at IS NULL AND a.source = 'svett' ORDER BY a.updated_at DESC LIMIT 1`,
      )
      .get();
    return {
      activities: count("SELECT count(*) AS n FROM activity WHERE deleted_at IS NULL"),
      sets: count("SELECT count(*) AS n FROM activity_set WHERE deleted_at IS NULL"),
      imports: { apple_health: imported("apple_health"), gpx: imported("gpx") },
      links: count(
        "SELECT count(*) AS n FROM activity_source WHERE deleted_at IS NULL AND activity_id = ?",
        String(hevy ?? ""),
      ),
      hevyHeart: heartRateSummary(beats),
      manual:
        manual === undefined
          ? null
          : {
              kind: String(manual["kind"]),
              startedAt: Number(manual["started_at"]),
              durationS: Number(manual["duration_s"]),
              distanceM: manual["distance_m"] === null ? null : Number(manual["distance_m"]),
              notes: String(manual["notes"]),
            },
    };
  } finally {
    database.close();
  }
};

type Expectation = { readonly line: string; readonly ok: (state: HealthState) => boolean };

const workouts = (activities: number, sets: number): Expectation => ({
  line: `${workoutsLabel(activities)} and ${sets} sets`,
  ok: (state) => state.activities === activities && state.sets === sets,
});
const imports = (health: number, gpx: number): Expectation => ({
  line: `${health} Apple Health and ${gpx} GPX imports on record`,
  ok: (state) => state.imports.apple_health === health && state.imports.gpx === gpx,
});
const linked: ReadonlyArray<Expectation> = [
  {
    line: "the Hevy workout records Apple Health as a linked source",
    ok: (state) => state.links === 1,
  },
  {
    line: "the Hevy workout gained the Health heart rate, average 112 and max 124 bpm",
    ok: (state) => state.hevyHeart?.averageBpm === 112 && state.hevyHeart.maxBpm === 124,
  },
];
const unlinked: Expectation = {
  line: "the Hevy workout has no linked source and no heart rate",
  ok: (state) => state.links === 0 && state.hevyHeart === null,
};

/** What each step of the proof leaves in the database. */
export const STAGES = {
  seeded: [workouts(1, 9), imports(0, 0), unlinked],
  declined: [workouts(1, 9), imports(0, 0), unlinked],
  imported: [workouts(4, 9), imports(1, 0), ...linked],
  again: [workouts(4, 9), imports(1, 0), ...linked],
  gpx: [workouts(5, 9), imports(1, 1), ...linked],
  manual: [
    workouts(6, 9),
    imports(1, 1),
    ...linked,
    {
      line: `the manual ride saved with its start, 1:05:00, 25.4 km and its notes`,
      ok: (state) =>
        state.manual?.kind === MANUAL.kind &&
        state.manual.startedAt === MANUAL.start &&
        state.manual.durationS === 3900 &&
        state.manual.distanceM === 25_400 &&
        state.manual.notes === MANUAL.notes,
    },
  ],
} satisfies Readonly<Record<string, ReadonlyArray<Expectation>>>;
export type Stage = keyof typeof STAGES;

export const isStage = (value: string): value is Stage => Object.hasOwn(STAGES, value);

export const judge = (stage: Stage, state: HealthState) => {
  const results = STAGES[stage].map((expectation) => ({
    ok: expectation.ok(state),
    line: expectation.line,
  }));
  return {
    ok: results.every((result) => result.ok),
    lines: results.map((result) => `${result.ok ? "PASSED" : "FAILED"}: ${stage}, ${result.line}`),
  };
};

if (import.meta.main) {
  const [command, first = "", second = ""] = process.argv.slice(2);
  switch (command) {
    case "files":
      writeFiles(first);
      console.log(join(first, EXPORT_FILE));
      console.log(join(first, GPX_FILE));
      break;
    case "seed":
      console.log(await seed(first));
      break;
    case "manual-link":
      console.log(manualLink());
      break;
    case "check": {
      if (!isStage(second)) throw new Error(`Unknown stage ${second}`);
      const result = judge(second, readState(first));
      console.log(result.lines.join("\n"));
      process.exitCode = result.ok ? 0 : 1;
      break;
    }
    default:
      throw new Error(`Unknown command ${command}`);
  }
}
