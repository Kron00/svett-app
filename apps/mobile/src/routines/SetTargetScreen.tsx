import {
  editNumberEntry,
  type KeypadKey,
  REPS_ENTRY,
  removeSet,
  replaceSet,
  type SetTargetEntry,
  type SetType,
  setTargetEntry,
  setTargetFromEntry,
  WEIGHT_ENTRY,
} from "@svett/core";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { useIsAccessibilityTextSize } from "../design/hooks";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { EntryField, Keypad } from "../ui/NumberEntry";
import { SegmentedControl } from "../ui/SegmentedControl";
import { workoutSettings } from "../settings/store";
import { changeDraft, useDraft } from "./draft";

type Field = "weight" | "repsFrom" | "repsTo";

const FIELDS: ReadonlyArray<{
  readonly field: Field;
  readonly label: string;
  readonly unit?: "weight";
  readonly testID: string;
}> = [
  { field: "weight", label: "Weight", unit: "weight", testID: "target-weight" },
  { field: "repsFrom", label: "Reps", testID: "target-reps-from" },
  { field: "repsTo", label: "Up to reps", testID: "target-reps-to" },
];

const SET_TYPE_OPTIONS: ReadonlyArray<{ readonly value: SetType; readonly label: string }> = [
  { value: "warm_up", label: "Warm-up" },
  { value: "normal", label: "Normal" },
  { value: "failure", label: "Failure" },
  { value: "drop", label: "Drop" },
];

/**
 * One set's target in the routine being edited: its type, weight, and an exact rep count
 * or a range. It edits the draft only when Done is pressed.
 */
export function SetTargetScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { params } = useRoute<RouteProp<RootStackParamList, "SetTarget">>();
  const exerciseIndex = Number(params.exercise);
  const setIndex = Number(params.set);
  const draft = useDraft();
  const set = draft?.form.exercises[exerciseIndex]?.sets[setIndex];
  // The unit the target opened in, so a switch elsewhere mid-edit never misreads the field.
  const [weightUnit] = useState(() => workoutSettings().unit);
  const [entry, setEntry] = useState<SetTargetEntry | null>(() =>
    set === undefined ? null : setTargetEntry(set, weightUnit),
  );
  const [focused, setFocused] = useState<Field>("repsFrom");
  const stacked = useIsAccessibilityTextSize();

  if (set === undefined || entry === null) {
    return (
      <View className="flex-1 bg-background">
        <EmptyState
          symbol="questionmark.circle"
          title="Set not found"
          message="Open a set from the routine you are editing."
        />
      </View>
    );
  }

  const limits = focused === "weight" ? WEIGHT_ENTRY[weightUnit] : REPS_ENTRY;
  const press = (key: KeypadKey) =>
    setEntry({ ...entry, [focused]: editNumberEntry(entry[focused], key, limits) });

  const done = () => {
    changeDraft((form) =>
      replaceSet(form, exerciseIndex, setIndex, setTargetFromEntry(entry, set, weightUnit)),
    );
    navigation.goBack();
  };
  const remove = () => {
    changeDraft((form) => removeSet(form, exerciseIndex, setIndex));
    navigation.goBack();
  };

  return (
    <ScrollView
      testID="set-target"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 20, padding: 16 }}
    >
      <SegmentedControl
        options={SET_TYPE_OPTIONS}
        selected={entry.setType}
        onSelect={(setType) => setEntry({ ...entry, setType })}
        accessibilityLabel="Set type"
      />
      <View className={stacked ? "gap-3" : "flex-row gap-3"}>
        {FIELDS.map(({ field, label, unit, testID }) => (
          <View key={field} className={stacked ? "gap-1" : "flex-1 gap-1"}>
            <AppText variant="footnote" tone="secondary" accessibilityElementsHidden>
              {label}
            </AppText>
            <EntryField
              label={label}
              value={entry[field]}
              placeholder="None"
              unit={unit === "weight" ? weightUnit : undefined}
              focused={focused === field}
              onPress={() => setFocused(field)}
              testID={testID}
            />
          </View>
        ))}
      </View>
      <AppText variant="footnote" tone="secondary">
        Fill in Up to reps for a rep range, such as 8 to 12. Leave it empty for an exact count.
      </AppText>
      <Keypad onKey={press} limits={limits} />
      <Button label="Done" onPress={done} testID="save-set" />
      <Button label="Remove set" variant="destructive" onPress={remove} testID="remove-set" />
    </ScrollView>
  );
}
