import {
  type BarsAndPlates,
  formatWeightNumber,
  plateSizeProblem,
  sortPlates,
  WEIGHT_UNIT_OPTIONS,
  type WeightUnit,
} from "@svett/core";
import { Alert, ScrollView, View } from "react-native";

import { useIsAccessibilityTextSize } from "../design/hooks";
import { changeBarsAndPlates, GearNotReady, useBarsAndPlates } from "../settings/gear";
import { changeWorkoutSettings, useWorkoutSettings } from "../settings/store";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { ListRow, ListSection, SectionHeader } from "../ui/List";
import { Stepper } from "../ui/NumberEntry";
import { SegmentedControl } from "../ui/SegmentedControl";

const MAX_PAIRS = 20;

/** A weight typed into a prompt, or null when it is not a number of at least zero. */
const typedWeight = (text: string | undefined): number | null => {
  const value = Number.parseFloat((text ?? "").replace(",", "."));
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const addPlate = (unit: WeightUnit, gear: BarsAndPlates) =>
  Alert.prompt(
    "Add a plate size",
    `Its weight in ${unit}.`,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Add",
        isPreferred: true,
        onPress: (text?: string) => {
          const weight = typedWeight(text);
          const problem = plateSizeProblem(weight, gear.plates);
          if (weight === null || problem !== undefined) {
            Alert.alert("That plate was not added", problem ?? "Enter the plate's weight.");
            return;
          }
          changeBarsAndPlates(unit, (gear) => ({
            ...gear,
            plates: sortPlates([...gear.plates, { weight, pairs: 1 }]),
          }));
        },
      },
    ],
    "plain-text",
    "",
    "decimal-pad",
  );

const addBar = (unit: WeightUnit) =>
  Alert.prompt("Add a bar", "What do you call it?", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Next",
      isPreferred: true,
      onPress: (name?: string) => {
        const named = name?.trim() ?? "";
        if (named === "") return;
        Alert.prompt(
          named,
          `Its weight in ${unit}.`,
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Add",
              isPreferred: true,
              onPress: (text?: string) => {
                const weight = typedWeight(text);
                if (weight === null || weight > 1000) {
                  Alert.alert("That bar was not added", "Enter its weight.");
                  return;
                }
                changeBarsAndPlates(unit, (gear) => ({
                  ...gear,
                  bars: [...gear.bars, { name: named, weight }],
                }));
              },
            },
          ],
          "plain-text",
          "",
          "decimal-pad",
        );
      },
    },
  ]);

/**
 * How you log on this phone: kilograms or pounds, whether sets ask for an RPE, and the
 * plates and bars you have, for the plate and warm-up calculators.
 */
export function WorkoutSettingsScreen() {
  const settings = useWorkoutSettings();
  const stacked = useIsAccessibilityTextSize();
  const { unit } = settings;
  const saved = useBarsAndPlates();
  if (saved.status !== "ready") return <GearNotReady query={saved} />;
  const gear = saved.value[unit];

  return (
    <ScrollView
      testID="workout-settings"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 pb-10 pt-4"
    >
      <View className="gap-2 px-gutter">
        <SectionHeader title="Weights in" />
        <SegmentedControl
          accessibilityLabel="Weight unit"
          options={WEIGHT_UNIT_OPTIONS}
          selected={unit}
          onSelect={(next) => changeWorkoutSettings((current) => ({ ...current, unit: next }))}
        />
        <AppText variant="footnote" tone="secondary" testID="unit-note">
          {`Weights show and are typed in ${unit === "kg" ? "kilograms" : "pounds"}. svett stores kilograms, so switching changes no workout.`}
        </AppText>
      </View>
      <ListSection footer="Rate each set from 6 to 10 by how many more reps you had left.">
        <ListRow
          title="Log RPE"
          testID="log-rpe"
          trailing={{
            type: "switch",
            value: settings.logRpe,
            onValueChange: (logRpe) => changeWorkoutSettings((current) => ({ ...current, logRpe })),
          }}
        />
      </ListSection>
      <View className="gap-3">
        <SectionHeader title={`Your plates, in ${unit}`} />
        <View className="mx-gutter gap-4 rounded-card bg-surface p-4">
          {gear.plates.map((plate, index) => (
            <View key={plate.weight} testID={`plate-${formatWeightNumber(plate.weight)}`}>
              <Stepper
                label={`Pairs of ${formatWeightNumber(plate.weight)} ${unit} plates`}
                valueText={String(plate.pairs)}
                onDecrement={() =>
                  changeBarsAndPlates(unit, (current) => ({
                    ...current,
                    plates: current.plates.map((other, at) =>
                      at === index ? { ...other, pairs: Math.max(0, other.pairs - 1) } : other,
                    ),
                  }))
                }
                onIncrement={() =>
                  changeBarsAndPlates(unit, (current) => ({
                    ...current,
                    plates: current.plates.map((other, at) =>
                      at === index
                        ? { ...other, pairs: Math.min(MAX_PAIRS, other.pairs + 1) }
                        : other,
                    ),
                  }))
                }
                decrementDisabled={plate.pairs === 0}
              />
            </View>
          ))}
        </View>
        <AppText variant="footnote" tone="secondary" className="px-8">
          A size with no pairs is never used.
        </AppText>
        <View className="px-gutter">
          <Button
            label="Add a plate size"
            symbol="plus"
            variant="secondary"
            onPress={() => addPlate(unit, gear)}
            testID="add-plate"
          />
        </View>
      </View>
      <View className="gap-3">
        <SectionHeader title={`Your bars, in ${unit}`} />
        <View className="mx-gutter overflow-hidden rounded-card bg-surface">
          {gear.bars.map((bar, index) => (
            <View
              key={`${bar.name}-${bar.weight}`}
              className={`min-h-target gap-2 px-gutter py-3 ${stacked ? "" : "flex-row items-center"}`}
            >
              <View
                accessible
                accessibilityLabel={`${bar.name}, ${formatWeightNumber(bar.weight)} ${unit}`}
                className="flex-1"
              >
                <AppText>{bar.name}</AppText>
                <AppText variant="subheadline" tone="secondary" numeric>
                  {`${formatWeightNumber(bar.weight)} ${unit}`}
                </AppText>
              </View>
              <IconButton
                symbol="trash"
                label={`Remove ${bar.name}`}
                disabled={gear.bars.length === 1}
                onPress={() =>
                  changeBarsAndPlates(unit, (current) => ({
                    ...current,
                    bars: current.bars.filter((_, at) => at !== index),
                  }))
                }
              />
            </View>
          ))}
        </View>
        <View className="px-gutter">
          <Button
            label="Add a bar"
            symbol="plus"
            variant="secondary"
            onPress={() => addBar(unit)}
            testID="add-bar"
          />
        </View>
      </View>
    </ScrollView>
  );
}
