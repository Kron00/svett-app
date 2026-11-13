import type { SetType } from "./schema.ts";

/** Rounds to at most two decimals and drops trailing zeros, so 82.50 reads "82.5". */
export const formatWeightKg = (kg: number): string => String(Math.round(kg * 100) / 100);

/** A set's weight and reps as the logger's previous column shows them, or null when it has neither. */
export const formatSetLoad = (weightKg: number | null, reps: number | null): string | null => {
  if (weightKg !== null && reps !== null) return `${formatWeightKg(weightKg)} kg × ${reps}`;
  if (weightKg !== null) return `${formatWeightKg(weightKg)} kg`;
  if (reps !== null) return `${reps} ${reps === 1 ? "rep" : "reps"}`;
  return null;
};

/** What the logger's first column shows for a set, and what VoiceOver reads for it. */
export type SetBadge = { readonly text: string; readonly label: string };

const OTHER_SET_BADGES: Readonly<Record<Exclude<SetType, "normal">, SetBadge>> = {
  warm_up: { text: "W", label: "Warm-up set" },
  failure: { text: "F", label: "Failure set" },
  drop: { text: "D", label: "Drop set" },
};

/**
 * Normal sets show their number among the exercise's normal sets. The other
 * types show a letter instead, as Hevy does.
 */
export const setBadge = (type: SetType, normalSetNumber: number): SetBadge =>
  type === "normal"
    ? { text: String(normalSetNumber), label: `Set ${normalSetNumber}` }
    : OTHER_SET_BADGES[type];
