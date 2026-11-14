import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActivityId,
  ActivityRepository,
  ActivitySetId,
  editNumberEntry,
  HistoryRepository,
  type NumberEntryLimits,
  REPS_ENTRY,
  type SetType,
  setEditFrom,
  setEditPatch,
  WEIGHT_ENTRY,
  type WeightUnit,
  type WorkoutSet,
} from "@svett/core";
import { Effect, Option, Schema } from "effect";
import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";

import { useQuery, write } from "../data/store";
import { workoutSettings } from "../settings/store";
import { useIsAccessibilityTextSize } from "../design/hooks";
import type { RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { EntryField, Keypad } from "../ui/NumberEntry";
import { SegmentedControl } from "../ui/SegmentedControl";

type Props = NativeStackScreenProps<RootStackParamList, "SetEdit">;
type Field = "weight" | "reps";

const limits = (unit: WeightUnit): Readonly<Record<Field, NumberEntryLimits>> => ({
  weight: WEIGHT_ENTRY[unit],
  reps: REPS_ENTRY,
});

const SET_TYPES: ReadonlyArray<{ readonly value: SetType; readonly label: string }> = [
  { value: "warm_up", label: "Warm-up" },
  { value: "normal", label: "Normal" },
  { value: "failure", label: "Failure" },
  { value: "drop", label: "Drop" },
];

const parseIds = Schema.decodeUnknownOption(
  Schema.Struct({ activityId: ActivityId, setId: ActivitySetId }),
);

function SetEditor({
  set,
  exerciseName,
  onDone,
}: {
  readonly set: WorkoutSet;
  readonly exerciseName: string;
  readonly onDone: () => void;
}) {
  const stacked = useIsAccessibilityTextSize();
  // The unit the set opened in, so a switch elsewhere mid-edit never misreads the field.
  const [unit] = useState(() => workoutSettings().unit);
  const [edit, setEdit] = useState(() => setEditFrom(set, unit));
  const [field, setField] = useState<Field>("weight");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // State only disables Save after a render, and taps can land before it.
  const savingNow = useRef(false);

  const save = () => {
    if (savingNow.current) return;
    const result = setEditPatch(edit, set, unit);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    savingNow.current = true;
    setSaving(true);
    write(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
        activities.updateSet(set.id, result.patch),
      ),
    ).then(onDone, (failure: unknown) => {
      savingNow.current = false;
      setSaving(false);
      setError(`The set was not saved. ${String(failure)}`);
    });
  };

  const entry = (name: Field, label: string, suffix: string) => (
    <View key={name} className={stacked ? "gap-1" : "flex-1 gap-1"}>
      <AppText variant="footnote" tone="secondary">
        {label}
      </AppText>
      <EntryField
        label={label}
        value={edit[name]}
        unit={suffix}
        focused={field === name}
        onPress={() => setField(name)}
      />
    </View>
  );

  return (
    <ScrollView
      testID="set-edit"
      className="flex-1 bg-background"
      contentContainerClassName="gap-5 px-gutter pb-10 pt-4"
    >
      <View className="gap-1">
        <AppText variant="title3" accessibilityRole="header">
          {exerciseName}
        </AppText>
        <AppText tone="secondary">{set.badge.label}</AppText>
      </View>
      <SegmentedControl
        accessibilityLabel="Set type"
        options={SET_TYPES}
        selected={edit.setType}
        onSelect={(setType) => setEdit((current) => ({ ...current, setType }))}
      />
      <View className={stacked ? "gap-3" : "flex-row gap-3"}>
        {entry("weight", "Weight", unit)}
        {entry("reps", "Reps", "reps")}
      </View>
      <Keypad
        limits={limits(unit)[field]}
        onKey={(key) => {
          setError(null);
          setEdit((current) => ({
            ...current,
            [field]: editNumberEntry(current[field], key, limits(unit)[field]),
          }));
        }}
      />
      {error ? (
        <AppText testID="set-edit-error" tone="destructive" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
      <View className="gap-2">
        <Button label="Save" testID="set-edit-save" disabled={saving} onPress={save} />
        <Button
          label="Cancel"
          variant="plain"
          testID="set-edit-cancel"
          disabled={saving}
          onPress={onDone}
        />
      </View>
    </ScrollView>
  );
}

/** Edits the type, weight and reps of one set in a past workout. */
export function SetEditScreen({ route, navigation }: Props) {
  const ids = Option.getOrNull(parseIds(route.params));
  const query = useQuery(`set-${route.params.activityId}-${route.params.setId}`, () =>
    ids === null
      ? Effect.succeed(Option.none())
      : Effect.flatMap(Effect.service(HistoryRepository), (history) =>
          history.workout(ids.activityId),
        ),
  );
  if (query.status === "loading") return <View className="flex-1 bg-background" />;
  const found =
    query.status === "ready"
      ? Option.getOrNull(query.value)
          ?.exercises.flatMap((entry) => entry.sets.map((set) => ({ entry, set })))
          .find(({ set }) => set.id === ids?.setId)
      : undefined;
  if (found === undefined) {
    return (
      <View className="flex-1 justify-center bg-background">
        <EmptyState
          symbol="questionmark.folder"
          title="This set is not here"
          message="Its workout may have been deleted."
          action={{ label: "Close", onPress: () => navigation.goBack() }}
        />
      </View>
    );
  }
  return (
    <SetEditor
      key={found.set.id}
      set={found.set}
      exerciseName={found.entry.name}
      onDone={() => navigation.goBack()}
    />
  );
}
