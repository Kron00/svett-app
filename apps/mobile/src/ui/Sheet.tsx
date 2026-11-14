import { BottomSheet, Group, Host, RNHostView } from "@expo/ui/swift-ui";
import { presentationDragIndicator, presentationSizing } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText } from "./AppText";

const SHEET_MODIFIERS = [
  presentationSizing("automatic", { fitted: { horizontal: false, vertical: true } }),
  presentationDragIndicator("visible"),
];

/**
 * A native iOS sheet that fits its content, with the system's glass
 * background and drag indicator. Swiping it down calls onDismiss.
 */
export function Sheet({
  isPresented,
  onDismiss,
  title,
  children,
}: {
  readonly isPresented: boolean;
  readonly onDismiss: () => void;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Host style={{ position: "absolute" }} pointerEvents="none">
      <BottomSheet
        isPresented={isPresented}
        onIsPresentedChange={(presented) => {
          if (!presented) onDismiss();
        }}
        fitToContents
      >
        <Group modifiers={SHEET_MODIFIERS}>
          <RNHostView matchContents={{ vertical: true }}>
            <View className="gap-4 px-gutter pb-6 pt-6">
              <AppText variant="headline" accessibilityRole="header" className="text-center">
                {title}
              </AppText>
              {children}
            </View>
          </RNHostView>
        </Group>
      </BottomSheet>
    </Host>
  );
}
