import { libraryExerciseId } from "./exercise-library.ts";
import { HEVY_LIBRARY, equipmentFromName } from "./hevy-exercises.ts";
import type { HevyFile, HevyWorkout } from "./hevy-file.ts";
import { canonicalJson, contentFingerprint, importedId } from "./ids.ts";
import { setFieldsFromSets } from "./logger.ts";
import { type EpochMillis, ExerciseId } from "./schema.ts";
import { TABLES } from "./table.ts";
import type {
  AnyRow,
  ImportInput,
  ImportRows,
  ItemSummary,
  PossibleDuplicate,
  Snapshot,
  TableKey,
  TableRows,
} from "./transfer.ts";

/** How a Hevy exercise name found its exercise, or null when you have to choose. */
export type NameMatchKind = "remembered" | "library" | "imported";

export interface NameMatch {
  readonly name: string;
  readonly exerciseId: ExerciseId | null;
  readonly how: NameMatchKind | null;
}

/** The custom exercise an import makes for a Hevy name you did not match to another. */
export const hevyExerciseId = (name: string): ExerciseId =>
  ExerciseId.make(importedId(TABLES.exercise.name, "hevy", name));

/** Every exercise name in the file, in the order it first appears. */
export const exerciseNames = (file: HevyFile): ReadonlyArray<string> => [
  ...new Set(file.workouts.flatMap((workout) => workout.exercises.map(({ name }) => name))),
];

type Lookup = Pick<Snapshot, "exercise" | "exerciseAlias">;

/**
 * Finds each name's exercise here: first a match you chose before, then the bundled table of
 * Hevy's names, then the custom exercise an earlier import made for it. A match whose
 * exercise you deleted no longer counts, so the name is asked again.
 */
export const matchNames = (
  names: ReadonlyArray<string>,
  local: Lookup,
): ReadonlyArray<NameMatch> => {
  const live = new Set(local.exercise.filter((row) => row.deletedAt === null).map((row) => row.id));
  const aliases = new Map(
    local.exerciseAlias
      .filter((row) => row.deletedAt === null && row["source"] === "hevy")
      .map((row) => [String(row["name"]), String(row["exerciseId"])]),
  );
  return names.map((name): NameMatch => {
    const remembered = aliases.get(name);
    if (remembered !== undefined && live.has(remembered)) {
      return { name, exerciseId: ExerciseId.make(remembered), how: "remembered" };
    }
    const library = HEVY_LIBRARY[name];
    if (library !== undefined && live.has(libraryExerciseId(library))) {
      return { name, exerciseId: libraryExerciseId(library), how: "library" };
    }
    if (live.has(hevyExerciseId(name))) {
      return { name, exerciseId: hevyExerciseId(name), how: "imported" };
    }
    return { name, exerciseId: null, how: null };
  });
};

type Rows = Partial<Record<TableKey, Array<AnyRow>>>;

const add = (rows: Rows, table: TableKey, row: AnyRow) => (rows[table] ??= []).push(row);

const liveOnly = (list: ReadonlyArray<AnyRow> | undefined) =>
  (list ?? []).filter((row) => row.deletedAt === null);

const byPosition = (a: AnyRow, b: AnyRow) => Number(a["position"]) - Number(b["position"]);

/** The exercises and sets of a workout, without IDs, times or notes. */
const setsSignature = (
  exercises: ReadonlyArray<AnyRow>,
  setsOf: (exerciseRowId: string) => ReadonlyArray<AnyRow>,
) =>
  canonicalJson(
    [...exercises]
      .sort(byPosition)
      .map((exercise) => [
        exercise["exerciseId"],
        exercise["supersetGroup"],
        [...setsOf(exercise.id)]
          .sort(byPosition)
          .map((set) => [
            set["setType"],
            set["weightKg"],
            set["reps"],
            set["durationS"],
            set["distanceM"],
            set["rpe"],
          ]),
      ]),
  );

const summaryOf = (id: string, workout: HevyWorkout): ItemSummary => ({
  key: `${TABLES.activity.name}/${id}`,
  table: "activity",
  id,
  title: workout.title || "Workout",
  at: workout.startedAt as EpochMillis,
});

const summaryHere = (row: AnyRow): ItemSummary => ({
  key: `${TABLES.activity.name}/${row.id}`,
  table: "activity",
  id: row.id,
  title: String(row["title"]) || "Workout",
  at: row["startedAt"] as EpochMillis,
});

const endOf = (startedAt: number, durationS: number) => startedAt + durationS * 1_000;

/** True when two workouts share any time, or start together. */
const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart === bStart || (aStart < bEnd && bStart < aEnd);

/**
 * Reads a Hevy file as svett rows. A workout's identity is its start time, so its rows get the
 * same IDs on every import and every device: the workout from `importedId` of its start, and
 * its exercises and sets from paths below it. A live workout here whose Hevy content has not
 * changed since it was imported comes back exactly as it is here, so your own edits to it never
 * show as a change. One you deleted, or an Undo removed, shows as changed, so you can take it.
 * One whose content changed brings its new rows, and marks deleted the exercises and sets of
 * yours it no longer has, so taking it gives exactly Hevy's version. Its start keeps the
 * instant saved here, since the same clock time read in another zone is still the same start.
 *
 * Following the plan's repeat rules, these new workouts are possible duplicates: a second one
 * with the same start as another in the file, one with a new start and the same exercises and
 * sets as one here, and one whose time overlaps a workout here from another source. Each is
 * imported only when its key is in `keep`. A kept second workout's identity adds its number
 * among the workouts that share its start, #1 for the second, so the two get different IDs and
 * keep them when Hevy writes newer workouts above them.
 *
 * A custom exercise an earlier import made, and Undo or you deleted, comes back with any
 * workout taken from the file that uses it.
 */
export const hevyImport = (file: HevyFile, keep: ReadonlySet<string> = new Set()): ImportInput => ({
  source: "hevy",
  read: (local, at): ImportRows => {
    const rows: Rows = {};
    const duplicates: Array<PossibleDuplicate> = [];
    const index = <K extends TableKey>(table: K) =>
      new Map(local[table].map((row) => [row.id, row]));
    const activities = index("activity");
    const exercisesHere = index("exercise");
    const exercisesOf = new Map<string, Array<AnyRow>>();
    for (const row of local.activityExercise) {
      const list = exercisesOf.get(String(row["activityId"])) ?? [];
      list.push(row);
      exercisesOf.set(String(row["activityId"]), list);
    }
    const setsOf = new Map<string, Array<AnyRow>>();
    for (const row of local.activitySet) {
      const list = setsOf.get(String(row["activityExerciseId"])) ?? [];
      list.push(row);
      setsOf.set(String(row["activityExerciseId"]), list);
    }
    // A workout in progress is a draft on this phone, so a Hevy workout never repeats it.
    const liveActivities = local.activity.filter(
      (row) => row.deletedAt === null && row["status"] === "finished",
    );
    const sameSets = new Map<string, AnyRow>();
    for (const row of liveActivities) {
      if (row["kind"] !== "strength") continue;
      const signature = setsSignature(liveOnly(exercisesOf.get(row.id)), (id) =>
        liveOnly(setsOf.get(id)),
      );
      if (!sameSets.has(signature)) sameSets.set(signature, row);
    }
    const otherSources = liveActivities.filter((row) => row["source"] !== "hevy");

    const matches = new Map(
      matchNames(exerciseNames(file), local).map((match) => [match.name, match.exerciseId]),
    );
    const usedNew = new Map<string, { cardio: boolean }>();

    // Earlier versions numbered a second workout at a start by its place in the whole file.
    const numberedHere = new Map<string, Array<AnyRow>>();
    for (const row of local.activity) {
      const sourceId = row["source"] === "hevy" ? String(row["sourceId"]) : "";
      const mark = sourceId.lastIndexOf("#");
      if (mark < 0) continue;
      const start = sourceId.slice(0, mark);
      numberedHere.set(start, [...(numberedHere.get(start) ?? []), row]);
    }
    const claimed = new Set<string>();
    /**
     * The identity of the workout numbered `number` among those that share its start: its
     * workout here with the same Hevy content, whatever number it was given, or else the number.
     */
    const twinIdentity = (workout: HevyWorkout, number: number) => {
      const same = (numberedHere.get(workout.start) ?? []).find(
        (row) =>
          row["fingerprint"] === workout.fingerprint && !claimed.has(String(row["sourceId"])),
      );
      if (same !== undefined) return String(same["sourceId"]);
      let free = number;
      while (claimed.has(`${workout.start}#${free}`)) free += 1;
      return `${workout.start}#${free}`;
    };

    const firstAt = new Map<string, { id: string; workout: HevyWorkout }>();
    const sharingStart = new Map<string, number>();
    for (const workout of file.workouts) {
      const first = firstAt.get(workout.start);
      const number = sharingStart.get(workout.start) ?? 0;
      sharingStart.set(workout.start, number + 1);
      const identity = number === 0 ? workout.start : twinIdentity(workout, number);
      claimed.add(identity);
      if (first !== undefined) {
        const id = importedId(TABLES.activity.name, "hevy", identity);
        const key = `hevy/${identity}`;
        // One kept on an earlier import is a workout here like any other.
        if (!activities.has(id)) {
          duplicates.push({
            key,
            summary: summaryOf(id, workout),
            reason: "same_start",
            other: summaryOf(first.id, first.workout),
            kept: keep.has(key),
          });
          if (!keep.has(key)) continue;
        }
      }
      const id = importedId(TABLES.activity.name, "hevy", identity);
      if (first === undefined) firstAt.set(workout.start, { id, workout });
      const here = activities.get(id);

      if (
        here !== undefined &&
        here.deletedAt === null &&
        here["source"] === "hevy" &&
        here["fingerprint"] === workout.fingerprint
      ) {
        add(rows, "activity", here);
        for (const exercise of exercisesOf.get(id) ?? []) {
          add(rows, "activityExercise", exercise);
          for (const set of setsOf.get(exercise.id) ?? []) add(rows, "activitySet", set);
        }
        continue;
      }

      const built: Rows = {};
      const newHere = new Map<string, { cardio: boolean }>();
      const exerciseFor = (name: string, cardio: boolean) => {
        const matched = matches.get(name);
        if (matched !== undefined && matched !== null) return matched;
        const seen = newHere.get(name) ?? usedNew.get(name);
        newHere.set(name, { cardio: (seen?.cardio ?? true) && cardio });
        return hevyExerciseId(name);
      };
      const path = (suffix: string) => `${identity}${suffix}`;
      workout.exercises.forEach((exercise, position) => {
        const exerciseRowId = importedId(
          TABLES.activityExercise.name,
          "hevy",
          path(`/exercise/${position}`),
        );
        const cardio = exercise.sets.length > 0 && exercise.sets.every((set) => set.reps === null);
        add(built, "activityExercise", {
          id: exerciseRowId,
          updatedAt: at,
          deletedAt: null,
          activityId: id,
          exerciseId: exerciseFor(exercise.name, cardio),
          position,
          supersetGroup: exercise.supersetGroup,
          notes: exercise.notes,
          setFields: setFieldsFromSets(exercise.sets) ?? "weight_reps",
          restS: null,
        });
        exercise.sets.forEach((set, setPosition) =>
          add(built, "activitySet", {
            id: importedId(
              TABLES.activitySet.name,
              "hevy",
              path(`/exercise/${position}/set/${setPosition}`),
            ),
            updatedAt: at,
            deletedAt: null,
            activityExerciseId: exerciseRowId,
            position: setPosition,
            ...set,
            done: true,
            targetRepsMin: null,
            targetRepsMax: null,
          }),
        );
      });

      if (here === undefined && first === undefined) {
        const signature = setsSignature(built.activityExercise ?? [], (exerciseRowId) =>
          (built.activitySet ?? []).filter((set) => set["activityExerciseId"] === exerciseRowId),
        );
        const twin = sameSets.get(signature);
        const end = endOf(workout.startedAt, workout.durationS);
        const overlapping = otherSources.find((other) =>
          overlaps(
            workout.startedAt,
            end,
            Number(other["startedAt"]),
            endOf(Number(other["startedAt"]), Number(other["durationS"])),
          ),
        );
        const other = twin ?? overlapping;
        if (other !== undefined) {
          const key = `hevy/${identity}`;
          duplicates.push({
            key,
            summary: summaryOf(id, workout),
            reason: twin === undefined ? "overlap" : "same_sets",
            other: summaryHere(other),
            kept: keep.has(key),
          });
          if (!keep.has(key)) continue;
        }
      }

      for (const [name, used] of newHere) usedNew.set(name, used);
      add(rows, "activity", {
        id,
        updatedAt: at,
        deletedAt: null,
        kind: "strength",
        startedAt: here?.["startedAt"] ?? workout.startedAt,
        durationS: workout.durationS,
        title: workout.title,
        notes: workout.description,
        energyKcal: null,
        audience: here?.["audience"] ?? "only_you",
        hiddenFields: here?.["hiddenFields"] ?? [],
        source: "hevy",
        sourceId: identity,
        fingerprint: workout.fingerprint,
        importBatchId: here?.["importBatchId"] ?? null,
        status: "finished",
        routineId: null,
      });
      const builtIds = new Set(
        [...(built.activityExercise ?? []), ...(built.activitySet ?? [])].map((row) => row.id),
      );
      for (const row of built.activityExercise ?? []) add(rows, "activityExercise", row);
      for (const row of built.activitySet ?? []) add(rows, "activitySet", row);
      for (const exercise of liveOnly(exercisesOf.get(id))) {
        const gone = !builtIds.has(exercise.id);
        if (gone) add(rows, "activityExercise", { ...exercise, deletedAt: at });
        for (const set of liveOnly(setsOf.get(exercise.id))) {
          if (gone || !builtIds.has(set.id)) add(rows, "activitySet", { ...set, deletedAt: at });
        }
      }
    }

    for (const [name, { cardio }] of usedNew) {
      const id = hevyExerciseId(name);
      const existing = exercisesHere.get(id);
      if (existing !== undefined) {
        // planImport brings it back with each workout taken that uses it, and only then.
        if (existing.deletedAt !== null) add(rows, "exercise", { ...existing, deletedAt: null });
        continue;
      }
      add(rows, "exercise", {
        id,
        updatedAt: at,
        deletedAt: null,
        name,
        category: cardio ? "cardio" : "strength",
        equipment: equipmentFromName(name),
        primaryMuscles: [],
        secondaryMuscles: [],
        source: "hevy",
        sourceId: name,
        fingerprint: contentFingerprint({ name }),
        importBatchId: null,
      });
    }
    return { tables: rows as TableRows, duplicates };
  },
});
