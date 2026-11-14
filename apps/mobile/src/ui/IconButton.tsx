import { Pressable } from "react-native";

import type { SymbolName } from "../design/tokens";
import { Icon } from "./Icon";

/**
 * A round button that shows only a symbol, at least 44 points across. Its label is
 * what VoiceOver reads. "filled" sits on a control background, "plain" on none.
 */
export function IconButton({
  symbol,
  label,
  onPress,
  variant = "filled",
  destructive = false,
  disabled = false,
  testID,
}: {
  readonly symbol: SymbolName;
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: "filled" | "plain";
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      className={`min-h-target min-w-target items-center justify-center rounded-full ${variant === "filled" ? "bg-control" : ""}`}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      <Icon
        name={symbol}
        color={destructive ? "destructive" : "accent"}
        size={variant === "filled" ? 18 : 22}
        weight="semibold"
      />
    </Pressable>
  );
}
