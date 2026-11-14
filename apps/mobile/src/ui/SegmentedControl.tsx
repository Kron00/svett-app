import { SegmentedControl as NativeSegmentedControl } from "@expo/ui/community/segmented-control";
import { Fragment } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useColor, useIsAccessibilityTextSize } from "../design/hooks";
import { AppText } from "./AppText";
import { Icon } from "./Icon";

export type SegmentedOption<Value extends string> = {
  readonly value: Value;
  readonly label: string;
};

/**
 * The native SwiftUI segmented picker, typed by its option values. Its segments
 * do not grow with accessibility text sizes, so there the options become rows
 * with a checkmark on the selected one, as a picker in Settings does.
 */
export function SegmentedControl<Value extends string>({
  options,
  selected,
  onSelect,
  accessibilityLabel,
}: {
  readonly options: ReadonlyArray<SegmentedOption<Value>>;
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  readonly accessibilityLabel: string;
}) {
  const stacked = useIsAccessibilityTextSize();
  const separator = useColor("separator");

  if (stacked) {
    return (
      <View className="overflow-hidden rounded-field bg-control">
        {options.map((option, index) => {
          const isSelected = option.value === selected;
          return (
            <Fragment key={option.value}>
              {index > 0 ? (
                <View
                  className="ml-4"
                  style={{ height: StyleSheet.hairlineWidth, backgroundColor: separator }}
                />
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={option.label}
                accessibilityHint={accessibilityLabel}
                accessibilityState={{ selected: isSelected }}
                onPress={() => onSelect(option.value)}
                className="min-h-target flex-row items-center gap-3 px-4 py-2"
              >
                <AppText className="flex-1">{option.label}</AppText>
                {isSelected ? (
                  <Icon name="checkmark" color="accent" size={17} weight="semibold" />
                ) : null}
              </Pressable>
            </Fragment>
          );
        })}
      </View>
    );
  }

  return (
    <NativeSegmentedControl
      values={options.map((option) => option.label)}
      selectedIndex={options.findIndex((option) => option.value === selected)}
      onChange={({ nativeEvent }) => {
        const option = options[nativeEvent.selectedSegmentIndex];
        if (option) onSelect(option.value);
      }}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
