import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { useColor } from "../design/hooks";
import { FieldOutline } from "./FieldOutline";
import { Icon } from "./Icon";

/** A search field with a clear button that is a full 44 point target. */
export function SearchField({
  label,
  value,
  onChangeText,
  placeholder,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder: string;
  readonly testID?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View className="min-h-target flex-row items-center gap-2 rounded-field bg-control pl-3">
      <Icon name="magnifyingglass" color="secondary-label" />
      <TextInput
        accessibilityRole="search"
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={useColor("tertiary-label")}
        selectionColor={useColor("accent")}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        testID={testID}
        className="flex-1 py-2.5 text-body text-label"
      />
      {value === "" ? (
        <View className="w-3" />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChangeText("")}
          className="min-h-target min-w-target items-center justify-center"
        >
          <Icon name="xmark.circle.fill" color="tertiary-label" />
        </Pressable>
      )}
      <FieldOutline focused={focused} />
    </View>
  );
}
