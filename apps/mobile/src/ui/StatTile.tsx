import { View } from "react-native";

import { useIsAccessibilityTextSize } from "../design/hooks";
import type { ColorToken, SymbolName } from "../design/tokens";
import { AppText } from "./AppText";
import { Icon } from "./Icon";

/** One number with its label, such as a workout's volume. Tiles wrap onto new lines as text grows. */
export function StatTile({
  label,
  value,
  unit,
  symbol,
  color = "accent",
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly symbol?: SymbolName;
  readonly color?: ColorToken;
  readonly testID?: string;
}) {
  const fullWidth = useIsAccessibilityTextSize();
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${value}${unit ? ` ${unit}` : ""}`}
      testID={testID}
      className={`gap-1 rounded-card bg-surface p-4 ${fullWidth ? "w-full" : "min-w-36 grow basis-36"}`}
    >
      <View className="flex-row items-center gap-1.5">
        {symbol ? <Icon name={symbol} color={color} size={13} weight="semibold" /> : null}
        <AppText variant="footnote" tone="secondary" className="shrink">
          {label}
        </AppText>
      </View>
      <View className="flex-row flex-wrap items-baseline gap-x-1">
        <AppText variant="title2" numeric>
          {value}
        </AppText>
        {unit ? (
          <AppText variant="subheadline" tone="secondary">
            {unit}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}
