import type { ReactNode } from "react";
import { ScrollView } from "react-native";

/**
 * A whole screen of centred content, such as an empty or failed state. It scrolls because a
 * native large title collapses and blurs only over a screen whose first view is a scroll view.
 */
export function NoticeScreen({
  testID,
  className = "",
  children,
}: {
  readonly testID?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <ScrollView
      testID={testID}
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerClassName={`grow justify-center py-6 ${className}`}
    >
      {children}
    </ScrollView>
  );
}
