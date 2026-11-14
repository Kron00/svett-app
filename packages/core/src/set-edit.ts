import type { ActivitySet, SetType } from "./schema.ts";
import { formatWeight, kgFromText, type WeightUnit } from "./weight-unit.ts";

/** The set type and the keypad text of each field, as the set edit screen holds them. */
export type SetEdit = {
  readonly setType: SetType;
  readonly weight: string;
  readonly reps: string;
};

type EditedSet = Pick<ActivitySet, "setType" | "weightKg" | "reps" | "durationS" | "distanceM">;

/** The edit a set opens with, its weight in `unit`. */
export const setEditFrom = (set: EditedSet, unit: WeightUnit = "kg"): SetEdit => ({
  setType: set.setType,
  weight: set.weightKg === null ? "" : formatWeight(set.weightKg, unit),
  reps: set.reps === null ? "" : String(set.reps),
});

export type SetEditResult =
  | {
      readonly ok: true;
      readonly patch: Pick<ActivitySet, "setType" | "weightKg" | "reps">;
    }
  | { readonly ok: false; readonly message: string };

const parse = (text: string): number | null => (text === "" ? null : Number(text));

/**
 * Turns the edit into the change to save. An empty field clears that value.
 * The set keeps its time and distance, and it must still record reps, a time
 * or a distance. The weight is typed in `unit` and stored in kilograms. A weight
 * field that still reads as the stored weight keeps it, because the field shows it
 * rounded, as for 225 lb in kilograms.
 */
export const setEditPatch = (
  edit: SetEdit,
  set: EditedSet,
  unit: WeightUnit = "kg",
): SetEditResult => {
  const reps = parse(edit.reps);
  if (reps === null && set.durationS === null && set.distanceM === null) {
    return { ok: false, message: "A set needs reps. Enter how many you did." };
  }
  const weightKg = kgFromText(edit.weight, set.weightKg, unit);
  return { ok: true, patch: { setType: edit.setType, weightKg, reps } };
};
