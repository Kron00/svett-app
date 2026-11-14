import { type ComponentProps, useState } from "react";
import { TextInput, View } from "react-native";

import { useColor } from "../design/hooks";
import { AppText } from "./AppText";
import { FieldOutline } from "./FieldOutline";

export type TextFieldProps = Omit<
  ComponentProps<typeof TextInput>,
  "className" | "style" | "accessibilityLabel"
> & {
  readonly label: string;
  /** Shown under the field in red, and read out with it. */
  readonly problem?: string;
  /** Shown under the field when there is no problem. */
  readonly note?: string;
};

/** A labelled one-line text field, at least 44 points tall, with an optional problem under it. Its text grows with Dynamic Type. */
export function TextField({
  label,
  problem,
  note,
  editable = true,
  onFocus,
  onBlur,
  ...props
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  const message = problem ?? note;
  return (
    <View className="gap-1">
      <AppText variant="footnote" tone="secondary" importantForAccessibility="no">
        {label}
      </AppText>
      <View
        className="min-h-target justify-center rounded-field bg-control px-3"
        style={{ opacity: editable ? 1 : 0.6 }}
      >
        <TextInput
          accessibilityLabel={problem === undefined ? label : `${label}, ${problem}`}
          accessibilityState={{ disabled: !editable }}
          editable={editable}
          placeholderTextColor={useColor("tertiary-label")}
          selectionColor={useColor("accent")}
          autoCapitalize="sentences"
          autoCorrect={false}
          returnKeyType="done"
          className="py-2.5 text-body text-label"
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          {...props}
        />
        <FieldOutline focused={focused} problem={problem !== undefined} />
      </View>
      {message === undefined ? null : (
        <AppText
          variant="footnote"
          tone={problem === undefined ? "secondary" : "destructive"}
          accessibilityLiveRegion="polite"
        >
          {message}
        </AppText>
      )}
    </View>
  );
}
