import {
  type ExerciseId,
  exerciseName,
  type SetType,
  setBadges,
  setTargetText,
  type TargetValues,
  type WeightUnit,
} from "@svett/core";

import { ListRow, ListSection } from "../ui/List";

export interface ShownExercise {
  readonly key: string;
  readonly exerciseId: ExerciseId;
  readonly notes: string;
  readonly sets: ReadonlyArray<TargetValues & { readonly key: string; readonly setType: SetType }>;
}

/**
 * A routine's exercises, one section each, with every set's type and target. The routine
 * screen and a coach proposal's preview both show a routine this way.
 */
export function RoutineExercises({
  exercises,
  names,
  unit,
  testIDPrefix = "routine-set",
}: {
  readonly exercises: ReadonlyArray<ShownExercise>;
  readonly names: ReadonlyMap<ExerciseId, string>;
  /** The unit targets show their weight in. */
  readonly unit: WeightUnit;
  /** Each set row's test ID is this, then its exercise and set index. */
  readonly testIDPrefix?: string;
}) {
  return exercises.map((exercise, exerciseIndex) => {
    const badges = setBadges(exercise.sets.map((set) => set.setType));
    return (
      <ListSection
        key={exercise.key}
        header={exerciseName(names, exercise.exerciseId)}
        footer={exercise.notes === "" ? undefined : exercise.notes}
      >
        {exercise.sets.length === 0 ? (
          <ListRow key="none" title="No sets" />
        ) : (
          exercise.sets.map((set, setIndex) => {
            const target = setTargetText(set, unit);
            const badge = badges[setIndex]!;
            return (
              <ListRow
                key={set.key}
                title={badge.label}
                value={target.text}
                accessibilityLabel={`${badge.label}, ${target.label}`}
                testID={`${testIDPrefix}-${exerciseIndex}-${setIndex}`}
              />
            );
          })
        )}
      </ListSection>
    );
  });
}
