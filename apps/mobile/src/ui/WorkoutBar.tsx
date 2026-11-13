import { GlassView } from "expo-glass-effect";
import { Pressable, View } from "react-native";
import { withUniwind } from "uniwind";

import { useIsAccessibilityTextSize } from "../design/hooks";
import { AppText } from "./AppText";
import { Icon } from "./Icon";

const Glass = withUniwind(GlassView);

/**
 * The bar that keeps a workout in progress in view above the tabs. It is a
 * Liquid Glass capsule, like the system's own playback bar.
 */
export function WorkoutBar({
  title,
  elapsed,
  onPress,
}: {
  readonly title: string;
  /** The running time, already formatted, such as "42:07". */
  readonly elapsed: string;
  readonly onPress: () => void;
}) {
  const stacked = useIsAccessibilityTextSize();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Workout in progress, ${title}, ${elapsed}`}
      accessibilityHint="Opens the workout"
      onPress={onPress}
    >
      <Glass isInteractive glassEffectStyle="regular" className="rounded-card">
        <View className="min-h-target flex-row items-center gap-3 px-4 py-3">
          <Icon name="dumbbell.fill" color="accent" size={17} />
          <View className={stacked ? "flex-1" : "flex-1 flex-row items-center gap-3"}>
            <AppText variant="headline" className={stacked ? "" : "flex-1"}>
              {title}
            </AppText>
            <AppText variant="subheadline" tone="secondary" numeric>
              {elapsed}
            </AppText>
          </View>
          <Icon name="chevron.up" color="secondary-label" size={14} weight="semibold" />
        </View>
      </Glass>
    </Pressable>
  );
}
