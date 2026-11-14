import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  formatWeightNumber,
  kgFrom,
  nextSet,
  plateLine,
  WARM_UP_RULE,
  warmUpSets,
  weightIn,
} from "@svett/core";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import type { RootStackParamList } from "../navigation";
import { useWorkoutSettings } from "../settings/store";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { SegmentedControl } from "../ui/SegmentedControl";
import { addWarmUpSets } from "../workout/actions";
import { useWorkout } from "../workout/store";

type Props = NativeStackScreenProps<RootStackParamList, "WarmUp">;

/**
 * Works out warm-up sets before an exercise's working weight, the heaviest weight its sets
 * hold, and adds them before its first set.
 */
export function WarmUpScreen({ route, navigation }: Props) {
  const workout = useWorkout();
  const { unit, barsAndPlates } = useWorkoutSettings();
  const { bars, plates } = barsAndPlates[unit];
  const [barIndex, setBarIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const bar = bars[Math.min(barIndex, bars.length - 1)]!;

  const log = workout.status === "ready" ? workout.log : null;
  const exercise = log?.exercises.find((entry) => entry.row.id === route.params.exercise);
  if (exercise === undefined) {
    return (
      <View className="flex-1 justify-center bg-background">
        <EmptyState
          symbol="questionmark.folder"
          title="This exercise is not in the workout"
          message="It may have been removed."
          action={{ label: "Close", onPress: () => navigation.goBack() }}
        />
      </View>
    );
  }
  const name = exercise.exercise?.name ?? "Deleted exercise";
  const workingKg = exercise.sets.reduce<number | null>(
    (most, set) =>
      set.setType !== "warm_up" && set.weightKg !== null && (most === null || set.weightKg > most)
        ? set.weightKg
        : most,
    null,
  );
  if (workingKg === null) {
    return (
      <View className="flex-1 justify-center bg-background">
        <EmptyState
          symbol="scalemass"
          title="No working weight yet"
          message={`Type the weight of a working set of ${name} first.`}
          action={{ label: "Close", onPress: () => navigation.goBack() }}
        />
      </View>
    );
  }
  const working = Math.round(weightIn(workingKg, unit) * 100) / 100;
  const sets = warmUpSets(working, bar.weight, plates);

  const add = () => {
    setAdding(true);
    void addWarmUpSets(
      exercise.row.id,
      sets.map((set) =>
        Object.assign(nextSet([]), {
          setType: "warm_up" as const,
          weightKg: kgFrom(set.weight, unit),
          reps: set.reps,
        }),
      ),
    ).then(() => navigation.goBack());
  };

  return (
    <ScrollView
      testID="warm-up"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerClassName="gap-5 pb-10 pt-4"
    >
      <View className="gap-1 px-gutter">
        <AppText variant="title3" accessibilityRole="header">
          {name}
        </AppText>
        <AppText tone="secondary" testID="warm-up-working">
          {`Working weight ${formatWeightNumber(working)} ${unit}`}
        </AppText>
      </View>
      <View className="px-gutter">
        <SegmentedControl
          accessibilityLabel="Bar"
          options={bars.map((option, index) => ({
            value: String(index),
            label: `${option.name}, ${formatWeightNumber(option.weight)} ${unit}`,
          }))}
          selected={String(Math.min(barIndex, bars.length - 1))}
          onSelect={(value) => setBarIndex(Number(value))}
        />
      </View>
      {sets.length === 0 ? (
        <AppText tone="secondary" className="px-gutter" testID="warm-up-none">
          {`${formatWeightNumber(working)} ${unit} needs no warm-up on this bar.`}
        </AppText>
      ) : (
        <ListSection footer={WARM_UP_RULE}>
          {sets.map((set, index) => (
            <ListRow
              key={set.percent}
              title={`${formatWeightNumber(set.weight)} ${unit} × ${set.reps}`}
              subtitle={
                set.load.perSide.length === 0
                  ? "Empty bar"
                  : `Each side ${plateLine(set.load)} ${unit}`
              }
              value={set.percent === 0 ? "Bar" : `${set.percent}%`}
              testID={`warm-up-set-${index}`}
            />
          ))}
        </ListSection>
      )}
      <View className="gap-2 px-gutter">
        <Button
          label={sets.length === 1 ? "Add 1 warm-up set" : `Add ${sets.length} warm-up sets`}
          disabled={sets.length === 0 || adding}
          onPress={add}
          testID="add-warm-ups"
        />
        <Button
          label="Edit your plates and bars"
          variant="plain"
          onPress={() => navigation.navigate("WorkoutSettings")}
        />
      </View>
    </ScrollView>
  );
}
