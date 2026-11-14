import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  editNumberEntry,
  formatWeight,
  formatWeightNumber,
  loadPlates,
  plateLabel,
  plateLine,
  type PlateLoad,
  WEIGHT_ENTRY,
  type WeightUnit,
} from "@svett/core";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import type { RootStackParamList } from "../navigation";
import { useWorkoutSettings } from "../settings/store";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EntryField, Keypad } from "../ui/NumberEntry";
import { SegmentedControl } from "../ui/SegmentedControl";

type Props = NativeStackScreenProps<RootStackParamList, "Plates">;

/** A weight from a link, in kilograms, or null when the link has none that makes sense. */
const linkedKg = (value: unknown): number | null => {
  const kg = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(kg) && kg >= 0 ? kg : null;
};

function Load({
  title,
  load,
  unit,
  testID,
}: {
  readonly title: string;
  readonly load: PlateLoad;
  readonly unit: WeightUnit;
  readonly testID: string;
}) {
  const total = `${formatWeightNumber(load.total)} ${unit}`;
  return (
    <View
      accessible
      accessibilityLabel={`${title}, ${total}. Each side, ${plateLabel(load, unit)}.`}
      testID={testID}
      className="gap-1 rounded-card bg-surface px-4 py-3"
    >
      <AppText variant="footnote" tone="secondary">
        {title}
      </AppText>
      <AppText variant="title2" numeric>
        {total}
      </AppText>
      <AppText tone="secondary">Each side</AppText>
      <AppText variant="title3" numeric>
        {load.perSide.length === 0 ? "No plates" : `${plateLine(load)} ${unit}`}
      </AppText>
    </View>
  );
}

/**
 * The plates on each side of the bar for a weight, from your own plates and bars. A weight
 * your plates cannot make shows the nearest lighter and heavier loads.
 */
export function PlatesScreen({ route, navigation }: Props) {
  const { unit, barsAndPlates } = useWorkoutSettings();
  const { bars, plates } = barsAndPlates[unit];
  const [text, setText] = useState(() => {
    const kg = linkedKg(route.params?.kg);
    return kg === null ? "" : formatWeight(kg, unit);
  });
  // The first key replaces a weight the screen opened with, as the logger's keypad does.
  const [fresh, setFresh] = useState(true);
  const [barIndex, setBarIndex] = useState(0);
  const bar = bars[Math.min(barIndex, bars.length - 1)]!;
  const target = text === "" ? null : Number.parseFloat(text);
  const result =
    target === null || !Number.isFinite(target) ? null : loadPlates(target, bar.weight, plates);
  const wanted = `${text} ${unit}`;

  return (
    <ScrollView
      testID="plates"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerClassName="gap-5 px-gutter pb-10 pt-4"
    >
      <View className="gap-1">
        <AppText variant="footnote" tone="secondary">
          Weight on the bar
        </AppText>
        <EntryField
          label="Weight on the bar"
          value={text}
          placeholder={`0 ${unit}`}
          unit={unit}
          focused
          onPress={() => undefined}
          testID="plates-weight"
        />
      </View>
      <SegmentedControl
        accessibilityLabel="Bar"
        options={bars.map((option, index) => ({
          value: String(index),
          label: `${option.name}, ${formatWeightNumber(option.weight)} ${unit}`,
        }))}
        selected={String(Math.min(barIndex, bars.length - 1))}
        onSelect={(value) => setBarIndex(Number(value))}
      />
      {result === null ? (
        <AppText tone="secondary" testID="plates-result">
          Type a weight to see the plates for it.
        </AppText>
      ) : result.kind === "exact" ? (
        <Load
          title={`On the ${bar.name.toLowerCase()}`}
          load={result.load}
          unit={unit}
          testID="plates-result"
        />
      ) : (
        <View className="gap-3">
          <AppText testID="plates-result" accessibilityLiveRegion="polite">
            {result.lighter === null
              ? `${wanted} is lighter than the ${bar.name.toLowerCase()}.`
              : `Your plates cannot make ${wanted} exactly.`}
          </AppText>
          {result.lighter !== null ? (
            <Load
              title="Nearest lighter"
              load={result.lighter}
              unit={unit}
              testID="plates-lighter"
            />
          ) : null}
          {result.heavier !== null ? (
            <Load
              title="Nearest heavier"
              load={result.heavier}
              unit={unit}
              testID="plates-heavier"
            />
          ) : null}
        </View>
      )}
      <Keypad
        limits={WEIGHT_ENTRY[unit]}
        onKey={(key) => {
          setText((current) =>
            editNumberEntry(fresh && key !== "delete" ? "" : current, key, WEIGHT_ENTRY[unit]),
          );
          setFresh(false);
        }}
      />
      <Button
        label="Edit your plates and bars"
        variant="plain"
        onPress={() => navigation.navigate("WorkoutSettings")}
        testID="edit-plates"
      />
    </ScrollView>
  );
}
