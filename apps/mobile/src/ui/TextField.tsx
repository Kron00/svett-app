import { useState } from "react";
import { TextInput, type TextInputProps, View } from "react-native";

import { useColor } from "../design/hooks";
import { AppText } from "./AppText";
import { FieldOutline } from "./FieldOutline";

/**
 * A labelled text field on the system keyboard, for words and numbers typed away from
 * a set, such as a name, a note or a duration. Its text grows with Dynamic Type. A
 * problem shows under it and is read with it.
 */
export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  maxLength,
  problem,
  keyboardType,
  multiline = false,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly problem?: string;
  readonly keyboardType?: TextInputProps["keyboardType"];
  readonly multiline?: boolean;
  readonly testID?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View className="gap-1">
      <AppText variant="footnote" tone="secondary" accessibilityElementsHidden>
        {label}
      </AppText>
      <View
        className={`min-h-target justify-center rounded-field bg-control px-3 ${problem ? "border-2 border-destructive" : ""}`}
      >
        <TextInput
          accessibilityLabel={label}
          accessibilityHint={problem}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={useColor("tertiary-label")}
          selectionColor={useColor("accent")}
          maxLength={maxLength}
          keyboardType={keyboardType}
          multiline={multiline}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCapitalize="sentences"
          autoCorrect={false}
          returnKeyType={multiline ? "default" : "done"}
          testID={testID}
          className={`py-2.5 text-body text-label ${multiline ? "min-h-24" : ""}`}
        />
        {problem ? null : <FieldOutline focused={focused} />}
      </View>
      {problem ? (
        <AppText variant="footnote" tone="destructive">
          {problem}
        </AppText>
      ) : null}
    </View>
  );
}
