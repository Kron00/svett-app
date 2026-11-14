import { Schema } from "effect";

import { linkParam, linkParams } from "./link-params.ts";
import { Equipment, type Exercise, Muscle } from "./schema.ts";

// Letters NFKD leaves whole, so "Søt" still finds "sot".
const LETTERS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  ø: "o",
  œ: "oe",
  ł: "l",
  đ: "d",
  þ: "th",
};

/** Lowercase words of letters and digits in any script, with accents and punctuation removed. */
export const foldText = (text: string): string =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[ßæøœłđþ]/g, (letter) => LETTERS[letter] ?? letter)
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export type ExerciseFilter = {
  readonly text: string;
  /** Matches an exercise whose primary muscles include it. */
  readonly muscle: Muscle | null;
  readonly equipment: Equipment | null;
};

export const NO_FILTER: ExerciseFilter = { text: "", muscle: null, equipment: null };

type Searchable = Pick<Exercise, "id" | "name" | "equipment" | "primaryMuscles">;

/**
 * How well a folded name matches a folded query, lower is better, or null for no match.
 * 0 the whole name, spaces aside, 1 the start of the name, 2 the phrase at the start of a later word,
 * 3 every query word starts a word in the name, 4 the query found anywhere once spaces
 * are ignored, so "pullup" finds "Pull-Up" and "pull up" finds "Pullups".
 */
const matchRank = (name: string, query: string): number | null => {
  const compactName = name.replaceAll(" ", "");
  const compactQuery = query.replaceAll(" ", "");
  if (compactName === compactQuery) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(` ${query}`)) return 2;
  const words = name.split(" ");
  const tokens = query.split(" ");
  if (tokens.every((token) => words.some((word) => word.startsWith(token)))) return 3;
  if (compactName.includes(compactQuery)) return 4;
  return null;
};

/**
 * The exercises that pass the muscle and equipment filters and match the text, best match
 * first. Equal matches put the shorter name first, then sort by name. Empty text lists
 * every exercise that passes the filters, by name.
 */
export const searchExercises = <E extends Searchable>(
  exercises: ReadonlyArray<E>,
  filter: ExerciseFilter,
): ReadonlyArray<E> => {
  const query = foldText(filter.text);
  const ranked: Array<{ readonly exercise: E; readonly rank: number; readonly name: string }> = [];
  for (const exercise of exercises) {
    if (filter.equipment !== null && exercise.equipment !== filter.equipment) continue;
    if (filter.muscle !== null && !exercise.primaryMuscles.includes(filter.muscle)) continue;
    const name = foldText(exercise.name);
    const rank = query === "" ? 0 : matchRank(name, query);
    if (rank !== null) ranked.push({ exercise, rank, name });
  }
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (query === "" ? 0 : a.name.length - b.name.length) ||
        compare(a.name, b.name) ||
        compare(a.exercise.id, b.exercise.id),
    )
    .map((entry) => entry.exercise);
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The filter in a link such as svett://exercises?q=bench&muscle=chest. A value svett does
 * not know drops that one filter instead of failing the link.
 */
export const exerciseFilterFromParams = (params: unknown): ExerciseFilter => {
  const record = linkParams(params);
  return {
    text: linkParam(Schema.String, record["q"]) ?? "",
    muscle: linkParam(Muscle, record["muscle"]),
    equipment: linkParam(Equipment, record["equipment"]),
  };
};

/** The route params that hold a filter, leaving out what is not set. */
export const exerciseFilterParams = (filter: ExerciseFilter) => ({
  q: filter.text === "" ? undefined : filter.text,
  muscle: filter.muscle ?? undefined,
  equipment: filter.equipment ?? undefined,
});
