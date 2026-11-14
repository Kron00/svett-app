import { Text, type TextProps } from "react-native";

import { TEXT_STYLES, type TextStyleName } from "../design/tokens";

const TONES = {
  label: "text-label",
  secondary: "text-secondary-label",
  tertiary: "text-tertiary-label",
  accent: "text-accent",
  destructive: "text-destructive",
  success: "text-success",
  onAccent: "text-on-accent",
} as const;

export type TextTone = keyof typeof TONES;

export type AppTextProps = TextProps & {
  readonly variant?: TextStyleName;
  readonly tone?: TextTone;
  /** Tabular digits, so a running timer or a column of weights does not jitter. */
  readonly numeric?: boolean;
  /** Layout classes only. Colour and size come from tone and variant. */
  readonly className?: string;
};

/** System font text in one of the iOS text styles, scaled by Dynamic Type. */
export function AppText({
  variant = "body",
  tone = "label",
  numeric = false,
  className,
  style,
  ...props
}: AppTextProps) {
  return (
    <Text
      dynamicTypeRamp={variant}
      className={`${TEXT_STYLES[variant]} ${TONES[tone]} ${className ?? ""}`}
      style={[numeric ? { fontVariant: ["tabular-nums"] } : null, style]}
      {...props}
    />
  );
}
