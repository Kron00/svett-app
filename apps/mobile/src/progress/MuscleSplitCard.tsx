import { formatWeightKg, MUSCLE_LABEL, MUSCLE_SPLIT_RULE, type MuscleShare } from "@svett/core";
import { View } from "react-native";

import { AppText } from "../ui/AppText";
import { SectionHeader } from "../ui/List";

/** How a workout's sets fall across muscles, as bars, with the rule that counted them. */
export function MuscleSplitCard({ split }: { readonly split: ReadonlyArray<MuscleShare> }) {
  return (
    <View testID="muscle-split" className="gap-2">
      <SectionHeader title="Muscle split" />
      <View className="mx-gutter gap-3 rounded-card bg-surface p-4">
        {split.map((share) => (
          <View
            key={share.muscle}
            accessible
            accessibilityLabel={`${MUSCLE_LABEL[share.muscle]}, ${share.percent} percent, ${formatWeightKg(share.sets)} sets`}
            className="gap-1"
          >
            <View className="flex-row flex-wrap justify-between gap-x-3">
              <AppText variant="subheadline">{MUSCLE_LABEL[share.muscle]}</AppText>
              <AppText variant="subheadline" tone="secondary" numeric>
                {share.percent}% · {formatWeightKg(share.sets)} sets
              </AppText>
            </View>
            <View className="h-2 overflow-hidden rounded-full bg-control">
              <View className="h-2 rounded-full bg-accent" style={{ width: `${share.percent}%` }} />
            </View>
          </View>
        ))}
      </View>
      <AppText variant="footnote" tone="secondary" className="px-8">
        {MUSCLE_SPLIT_RULE}
      </AppText>
    </View>
  );
}
