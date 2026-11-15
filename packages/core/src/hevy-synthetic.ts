import { HEVY_LIBRARY } from "./hevy-exercises.ts";

// Hevy's workout CSV columns, in the order its export writes them.
const COLUMNS = [
  "title",
  "start_time",
  "end_time",
  "description",
  "exercise_title",
  "superset_id",
  "exercise_notes",
  "set_index",
  "set_type",
  "weight_kg",
  "reps",
  "distance_km",
  "duration_seconds",
  "rpe",
] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Names Hevy uses that all map to the library, so the import needs no matching.
const DAYS = [
  {
    title: "Push",
    exercises: [
      "Bench Press (Barbell)",
      "Incline Bench Press (Dumbbell)",
      "Chest Fly (Dumbbell)",
      "Triceps Dip",
      "Push Up",
    ],
  },
  {
    title: "Legs",
    exercises: ["Squat (Barbell)", "Front Squat", "Full Squat", "Decline Push Up", "Bench Dip"],
  },
  {
    title: "Chest",
    exercises: [
      "Decline Bench Press (Barbell)",
      "Close Grip Bench Press (Barbell)",
      "Chest Press (Machine)",
      "Butterfly (Pec Deck)",
      "Cable Fly Crossovers",
    ],
  },
] as const;

/** A wall time as Hevy writes it, such as "3 Nov 2026, 18:30". */
const hevyTime = (millis: number) => {
  const at = new Date(millis);
  const minutes = String(at.getUTCMinutes()).padStart(2, "0");
  const hours = String(at.getUTCHours()).padStart(2, "0");
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${hours}:${minutes}`;
};

const quoted = (value: string | number | null) =>
  value === null
    ? ""
    : typeof value === "number"
      ? String(value)
      : `"${value.replaceAll('"', '""')}"`;

/**
 * A Hevy workout export with `count` strength workouts, every second day from `firstDay` at
 * 18:30, each with five exercises of a warm-up and three working sets. The same count always
 * gives the same file. It stands in for a long Hevy history when the import is timed.
 */
export const syntheticHevyCsv = (count: number, firstDay = Date.UTC(2024, 10, 4)): string => {
  const rows: Array<string> = [COLUMNS.map((column) => quoted(column)).join(",")];
  for (let workout = 0; workout < count; workout++) {
    const day = DAYS[workout % DAYS.length] ?? DAYS[0];
    const start = firstDay + workout * 2 * 86_400_000 + (18 * 60 + 30) * 60_000;
    const end = start + 65 * 60_000;
    // Weights creep up over the weeks, as a real history's do.
    const progress = Math.floor(workout / DAYS.length) * 0.5;
    day.exercises.forEach((exercise, position) => {
      if (HEVY_LIBRARY[exercise] === undefined)
        throw new Error(`${exercise} is not in the library`);
      const working = 40 + position * 10 + progress;
      const sets = [
        { type: "warmup", kg: Math.round(working * 0.5), reps: 10 },
        { type: "normal", kg: working, reps: 8 },
        { type: "normal", kg: working, reps: 8 },
        { type: "normal", kg: working, reps: 7 },
      ];
      sets.forEach((set, index) =>
        rows.push(
          [
            quoted(day.title),
            quoted(hevyTime(start)),
            quoted(hevyTime(end)),
            quoted(""),
            quoted(exercise),
            null,
            quoted(""),
            index,
            quoted(set.type),
            set.kg,
            set.reps,
            null,
            null,
            index === 3 ? 8 : null,
          ]
            .map((value) => (typeof value === "string" ? value : quoted(value)))
            .join(","),
        ),
      );
    });
  }
  return `${rows.join("\n")}\n`;
};
