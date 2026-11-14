import { View } from "react-native";

import { useIsAccessibilityTextSize } from "../design/hooks";
import { AppText } from "./AppText";
import { Button } from "./Button";

/**
 * The rest timer under the workout: the time left, a bar that empties as it runs, and
 * buttons that move it 15 seconds either way or end it. At accessibility text sizes the
 * buttons move under the time.
 */
export function RestTimerBar({
  left,
  leftLabel,
  progress,
  adjustSeconds,
  onLess,
  onMore,
  onSkip,
  atBottom = true,
  testID,
}: {
  /** The time left, already formatted, such as "1:23". */
  readonly left: string;
  /** What VoiceOver reads for it, such as "1 minute 23 seconds". */
  readonly leftLabel: string;
  /** How much of the rest is left, from 1 down to 0. */
  readonly progress: number;
  readonly adjustSeconds: number;
  readonly onLess: () => void;
  readonly onMore: () => void;
  readonly onSkip: () => void;
  /** Whether it is the last thing on screen, above the home indicator. */
  readonly atBottom?: boolean;
  readonly testID?: string;
}) {
  const stacked = useIsAccessibilityTextSize();
  const buttons = (
    <View className="flex-row gap-2">
      <Button
        label={`−${adjustSeconds}`}
        accessibilityLabel={`${adjustSeconds} seconds less`}
        variant="secondary"
        onPress={onLess}
        testID={testID === undefined ? undefined : `${testID}-less`}
      />
      <Button
        label={`+${adjustSeconds}`}
        accessibilityLabel={`${adjustSeconds} seconds more`}
        variant="secondary"
        onPress={onMore}
        testID={testID === undefined ? undefined : `${testID}-more`}
      />
      <Button
        label="Skip"
        accessibilityLabel="Skip rest"
        onPress={onSkip}
        testID={testID === undefined ? undefined : `${testID}-skip`}
      />
    </View>
  );
  return (
    <View
      testID={testID}
      className={`gap-2 border-t border-separator bg-surface px-gutter pt-3 ${atBottom ? "pb-8" : "pb-3"}`}
    >
      <View className="h-1 overflow-hidden rounded-full bg-control">
        <View
          className="h-1 rounded-full bg-accent"
          style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
        />
      </View>
      <View className={stacked ? "gap-2" : "flex-row items-center gap-3"}>
        <View
          accessible
          accessibilityRole="timer"
          accessibilityLabel={`Rest, ${leftLabel} left`}
          testID={testID === undefined ? undefined : `${testID}-left`}
          className={stacked ? "" : "flex-1"}
        >
          <AppText variant="footnote" tone="secondary">
            Rest
          </AppText>
          <AppText variant="title2" numeric>
            {left}
          </AppText>
        </View>
        {buttons}
      </View>
    </View>
  );
}
