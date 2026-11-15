import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useRef, useState } from "react";
import { AccessibilityInfo, ScrollView, type ScrollViewInstance, View } from "react-native";

import type { RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { FIRST_RUN_PAGES } from "./pages";
import { rememberFirstRunSeen } from "./store";

type Props = NativeStackScreenProps<RootStackParamList, "FirstRun">;

/**
 * The few pages a fresh install opens on. They ask for nothing: no sign-in and no permission.
 * Skip and the last page both remember they were seen and open the Train tab.
 */
export function FirstRunScreen({ navigation }: Props) {
  const [index, setIndex] = useState(0);
  const scroll = useRef<ScrollViewInstance>(null);
  const page = FIRST_RUN_PAGES[Math.min(index, FIRST_RUN_PAGES.length - 1)];
  const last = index >= FIRST_RUN_PAGES.length - 1;
  if (page === undefined) return null;

  const finish = () => {
    rememberFirstRunSeen();
    navigation.reset({ index: 0, routes: [{ name: "Tabs", params: { screen: "Train" } }] });
  };
  const next = () => {
    const following = FIRST_RUN_PAGES[index + 1];
    if (following === undefined) return finish();
    setIndex(index + 1);
    // The page changes in place, with no motion, so VoiceOver hears the new one's title.
    scroll.current?.scrollTo({ y: 0, animated: false });
    AccessibilityInfo.announceForAccessibility(following.title);
  };

  return (
    <ScrollView
      ref={scroll}
      testID="first-run"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerClassName="grow gap-6 px-gutter py-6"
    >
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <AppText testID="first-run-step" variant="footnote" tone="secondary">
          {`${index + 1} of ${FIRST_RUN_PAGES.length}`}
        </AppText>
        <Button
          label="Skip"
          variant="plain"
          testID="first-run-skip"
          accessibilityHint="Opens the Train tab"
          onPress={finish}
        />
      </View>
      <View testID={`first-run-${page.id}`} className="grow justify-center gap-4">
        <Icon name={page.symbol} color="accent" size={56} />
        <AppText testID="first-run-title" variant="largeTitle" accessibilityRole="header">
          {page.title}
        </AppText>
        <AppText tone="secondary">{page.body}</AppText>
      </View>
      <Button
        label={last ? "Start training" : "Next"}
        testID="first-run-next"
        accessibilityHint={last ? "Opens the Train tab" : "Shows the next page"}
        onPress={next}
      />
    </ScrollView>
  );
}
