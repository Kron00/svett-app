import { Pressable } from "react-native";

import type { ColorToken, SymbolName } from "../design/tokens";
import { AppText, type TextTone } from "./AppText";
import { Icon } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "destructive" | "plain";

const VARIANTS: Readonly<
  Record<ButtonVariant, { container: string; tone: TextTone; symbol: ColorToken }>
> = {
  primary: { container: "bg-accent-fill", tone: "onAccent", symbol: "on-accent" },
  secondary: { container: "bg-control", tone: "accent", symbol: "accent" },
  destructive: { container: "bg-destructive-fill", tone: "destructive", symbol: "destructive" },
  plain: { container: "", tone: "accent", symbol: "accent" },
};

export type ButtonProps = {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly symbol?: SymbolName;
  readonly disabled?: boolean;
  readonly accessibilityHint?: string;
  readonly testID?: string;
};

/** A capsule button, at least 44 points tall. Its label wraps at large text sizes. */
export function Button({
  label,
  onPress,
  variant = "primary",
  symbol,
  disabled = false,
  accessibilityHint,
  testID,
}: ButtonProps) {
  const style = VARIANTS[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      className={`min-h-target shrink flex-row items-center justify-center gap-2 rounded-full px-5 py-3 ${style.container}`}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      {symbol ? <Icon name={symbol} color={style.symbol} weight="semibold" /> : null}
      <AppText variant="headline" tone={style.tone} className="shrink text-center">
        {label}
      </AppText>
    </Pressable>
  );
}
