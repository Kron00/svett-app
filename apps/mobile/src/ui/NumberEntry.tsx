import { KEYPAD_KEYS, type KeypadKey, type NumberEntryLimits } from "@svett/core";
import { Pressable, View } from "react-native";

import type { SymbolName } from "../design/tokens";
import { AppText } from "./AppText";
import { FieldOutline } from "./FieldOutline";
import { Icon } from "./Icon";

// Digits on the keys and stepper stop growing at twice their size, so a key
// stays a key at the largest text sizes. Apple's own keypads do the same.
const KEY_TEXT_MAX_SCALE = 2;

function Key({
  label,
  onPress,
  symbol,
  children,
  testID,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly symbol?: SymbolName;
  readonly children?: string;
  readonly testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      className="min-h-key flex-1 items-center justify-center rounded-key bg-control"
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      {symbol ? (
        <Icon name={symbol} size={24} />
      ) : (
        <AppText variant="title1" numeric maxFontSizeMultiplier={KEY_TEXT_MAX_SCALE}>
          {children}
        </AppText>
      )}
    </Pressable>
  );
}

/**
 * A number pad for weight and reps, with keys well over the 44 point minimum
 * for use mid-set. It reports presses; editNumberEntry in @svett/core turns
 * them into the field's text.
 */
export function Keypad({
  onKey,
  limits,
}: {
  readonly onKey: (key: KeypadKey) => void;
  /** Whole numbers such as reps leave the decimal key blank. */
  readonly limits: NumberEntryLimits;
}) {
  const decimal = limits.decimals > 0;
  const rows = [0, 3, 6, 9].map((start) => KEYPAD_KEYS.slice(start, start + 3));
  return (
    <View className="gap-2">
      {rows.map((row) => (
        <View key={row.join()} className="flex-row gap-2">
          {row.map((key) => {
            if (key === "delete") {
              return (
                <Key
                  key={key}
                  label="Delete"
                  symbol="delete.left"
                  onPress={() => onKey(key)}
                  testID="key-delete"
                />
              );
            }
            if (key === ".") {
              return decimal ? (
                <Key
                  key={key}
                  label="Decimal point"
                  onPress={() => onKey(key)}
                  testID="key-decimal"
                >
                  .
                </Key>
              ) : (
                <View key={key} className="flex-1" />
              );
            }
            return (
              <Key key={key} label={key} onPress={() => onKey(key)} testID={`key-${key}`}>
                {key}
              </Key>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** A field that shows what the keypad typed. It opens the keypad instead of the system keyboard. */
export function EntryField({
  label,
  value,
  placeholder,
  unit,
  focused = false,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  /** Shown dimmed while the field is empty, such as the previous set's weight. */
  readonly placeholder?: string;
  readonly unit?: string;
  readonly focused?: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  const shown = value === "" ? (placeholder ?? "") : value;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={{ text: value === "" ? "Empty" : `${value}${unit ? ` ${unit}` : ""}` }}
      accessibilityState={{ selected: focused }}
      onPress={onPress}
      testID={testID}
      className={`min-h-target flex-row flex-wrap items-baseline justify-center gap-x-1 rounded-field px-2 py-2 ${focused ? "bg-surface" : "bg-control"}`}
    >
      <FieldOutline focused={focused} />
      <AppText variant="headline" tone={value === "" ? "secondary" : "label"} numeric>
        {shown}
      </AppText>
      {unit ? (
        <AppText variant="footnote" tone="secondary">
          {unit}
        </AppText>
      ) : null}
    </Pressable>
  );
}

/**
 * Big minus and plus buttons around a value. VoiceOver reads it as one
 * adjustable control, so a swipe up or down steps it.
 */
export function Stepper({
  label,
  valueText,
  unit,
  onIncrement,
  onDecrement,
  decrementDisabled = false,
}: {
  readonly label: string;
  readonly valueText: string;
  readonly unit?: string;
  readonly onIncrement: () => void;
  readonly onDecrement: () => void;
  readonly decrementDisabled?: boolean;
}) {
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: unit ? `${valueText} ${unit}` : valueText }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "increment") onIncrement();
        if (nativeEvent.actionName === "decrement" && !decrementDisabled) onDecrement();
      }}
      className="flex-row items-center gap-3"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Decrease ${label}`}
        onPress={onDecrement}
        disabled={decrementDisabled}
        className="size-key items-center justify-center rounded-key bg-control"
        style={({ pressed }) => ({ opacity: decrementDisabled ? 0.4 : pressed ? 0.5 : 1 })}
      >
        <Icon name="minus" size={22} weight="semibold" />
      </Pressable>
      <View className="flex-1 items-center">
        <AppText variant="footnote" tone="secondary">
          {label}
        </AppText>
        <View className="flex-row flex-wrap items-baseline justify-center gap-x-1">
          <AppText variant="title1" numeric maxFontSizeMultiplier={KEY_TEXT_MAX_SCALE}>
            {valueText}
          </AppText>
          {unit ? (
            <AppText variant="callout" tone="secondary" maxFontSizeMultiplier={KEY_TEXT_MAX_SCALE}>
              {unit}
            </AppText>
          ) : null}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Increase ${label}`}
        onPress={onIncrement}
        className="size-key items-center justify-center rounded-key bg-control"
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
      >
        <Icon name="plus" size={22} weight="semibold" />
      </Pressable>
    </View>
  );
}
