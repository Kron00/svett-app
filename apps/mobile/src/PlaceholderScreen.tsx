import type { ReactNode } from "react";
import { ScrollView } from "react-native";

import type { Tab } from "./tabs";
import { AppText } from "./ui/AppText";

export function PlaceholderScreen({
  tab,
  children,
}: {
  readonly tab: Tab;
  readonly children?: ReactNode;
}) {
  return (
    <ScrollView
      testID={`tab-${tab.name.toLowerCase()}`}
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerClassName="grow items-center justify-center gap-2 px-8 py-6"
    >
      <AppText tone="secondary" className="text-center">
        {tab.summary}
      </AppText>
      {children}
    </ScrollView>
  );
}
