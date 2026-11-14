import { View } from "react-native";

import type { SymbolName } from "../design/tokens";
import { AppText } from "./AppText";
import { Button } from "./Button";
import { Icon } from "./Icon";

/** What a screen shows before it has anything to list, with the one action that fills it. */
export function EmptyState({
  symbol,
  title,
  message,
  action,
}: {
  readonly symbol: SymbolName;
  readonly title: string;
  readonly message: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <View className="items-center gap-3 px-8 py-6">
      <Icon name={symbol} color="tertiary-label" size={44} />
      <View className="items-center gap-1">
        <AppText variant="title3" accessibilityRole="header" className="text-center">
          {title}
        </AppText>
        <AppText tone="secondary" className="text-center">
          {message}
        </AppText>
      </View>
      {action ? <Button label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}
