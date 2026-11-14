import { useState } from "react";
import { TextInput, View } from "react-native";

import { useColor } from "../design/hooks";
import { AppText } from "./AppText";
import { FieldOutline } from "./FieldOutline";

/** A labelled one-line text field. Its text grows with Dynamic Type. */
export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  maxLength,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly testID?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View className="gap-1">
      <AppText variant="footnote" tone="secondary" accessibilityElementsHidden>
        {label}
      </AppText>
      <View className="min-h-target justify-center rounded-field bg-control px-3">
        <TextInput
          accessibilityLabel={label}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={useColor("tertiary-label")}
          selectionColor={useColor("accent")}
          maxLength={maxLength}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCapitalize="sentences"
          autoCorrect={false}
          returnKeyType="done"
          testID={testID}
          className="py-2.5 text-body text-label"
        />
        <FieldOutline focused={focused} />
      </View>
    </View>
  );
}
