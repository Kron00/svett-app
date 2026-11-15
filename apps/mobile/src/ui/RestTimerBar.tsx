import { REST_ADJUST_S } from "@svett/core";
import { View } from "react-native";

import { useIsAccessibilityTextSize } from "../design/hooks";
import { AppText } from "./AppText";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

/**
 * The rest timer under the workout: the time left, a bar that empties as it runs, and
 * buttons that move it 15 seconds either way or end it. At accessibility text sizes the
 * buttons move under the time. A compact bar, above the keypad, keeps to one row there
 * instead, with symbols for the 15 seconds, so the set being typed into still shows.
 */
export function RestTimerBar({
  left,
  leftLabel,
  progress,
  onLess,
  onMore,
  onSkip,
  atBottom = true,
  compact = false,
  testID,
}: {
  /** The time left, already formatted, such as "1:23". */
  readonly left: string;
  /** What VoiceOver reads for it, such as "1 minute 23 seconds". */
  readonly leftLabel: string;
  /** How much of the rest is left, from 1 down to 0. */
  readonly progress: number;
  readonly onLess: () => void;
  readonly onMore: () => void;
  readonly onSkip: () => void;
  /** Whether it is the last thing on screen, above the home indicator. */
  readonly atBottom?: boolean;
  /** Whether it shares the screen with the keypad, so it takes as little height as it can. */
  readonly compact?: boolean;
  readonly testID?: string;
}) {
  const large = useIsAccessibilityTextSize();
  const oneRow = compact && large;
  const id = (part: string) => (testID === undefined ? undefined : `${testID}-${part}`);
  const lessLabel = `${REST_ADJUST_S} seconds less`;
  const moreLabel = `${REST_ADJUST_S} seconds more`;
  const skip = (
    <Button label="Skip" accessibilityLabel="Skip rest" onPress={onSkip} testID={id("skip")} />
  );
  const buttons = oneRow ? (
    <View className="flex-row items-center gap-2">
      <IconButton symbol="gobackward.15" label={lessLabel} onPress={onLess} testID={id("less")} />
      <IconButton symbol="goforward.15" label={moreLabel} onPress={onMore} testID={id("more")} />
      {skip}
    </View>
  ) : (
    <View className="flex-row gap-2">
      <Button
        label={`−${REST_ADJUST_S}`}
        accessibilityLabel={lessLabel}
        variant="secondary"
        onPress={onLess}
        testID={id("less")}
      />
      <Button
        label={`+${REST_ADJUST_S}`}
        accessibilityLabel={moreLabel}
        variant="secondary"
        onPress={onMore}
        testID={id("more")}
      />
      {skip}
    </View>
  );
  const row = oneRow
    ? // A time too wide to share the row moves the buttons to a row of their own, never clipping.
      "flex-row flex-wrap items-center gap-2"
    : large
      ? "gap-2"
      : "flex-row items-center gap-3";
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
      <View className={row}>
        <View
          accessible
          accessibilityRole="timer"
          accessibilityLabel={`Rest, ${leftLabel} left`}
          testID={id("left")}
          className={oneRow ? "grow" : large ? "" : "flex-1"}
        >
          {/* One row has no room for the word, which VoiceOver still reads. */}
          {oneRow ? null : (
            <AppText variant="footnote" tone="secondary">
              Rest
            </AppText>
          )}
          <AppText variant={oneRow ? "headline" : "title2"} numeric>
            {left}
          </AppText>
        </View>
        {buttons}
      </View>
    </View>
  );
}
