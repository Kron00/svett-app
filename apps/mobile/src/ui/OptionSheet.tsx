import { Fragment } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { useColor } from "../design/hooks";
import { AppText } from "./AppText";
import { Button } from "./Button";
import { Icon } from "./Icon";

export type Option<Value extends string> = {
  readonly value: Value;
  readonly label: string;
};

type Choice<Value extends string> =
  | {
      readonly mode: "single";
      readonly selected: Value | null;
      readonly onSelect: (value: Value | null) => void;
      /** A first row that clears the choice, such as "All muscles". */
      readonly noneLabel?: string;
    }
  | {
      readonly mode: "multiple";
      readonly selected: ReadonlyArray<Value>;
      readonly onSelect: (values: ReadonlyArray<Value>) => void;
    };

function OptionRow({
  label,
  selected,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      testID={testID}
      className="min-h-target flex-row items-center gap-3 px-gutter py-3"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <AppText className="flex-1">{label}</AppText>
      {selected ? <Icon name="checkmark" color="accent" weight="semibold" /> : null}
    </Pressable>
  );
}

/**
 * A page sheet that lists options with a checkmark on each chosen one. One choice
 * closes it, and a multiple choice closes on Done. It is UIKit's own page sheet,
 * not the fitted Sheet, because a long list at the largest text size must scroll.
 */
export function OptionSheet<Value extends string>({
  title,
  options,
  isPresented,
  onDismiss,
  testID,
  ...choice
}: {
  readonly title: string;
  readonly options: ReadonlyArray<Option<Value>>;
  readonly isPresented: boolean;
  readonly onDismiss: () => void;
  readonly testID?: string;
} & Choice<Value>) {
  const separator = useColor("separator");
  const isSelected = (value: Value) =>
    choice.mode === "single" ? choice.selected === value : choice.selected.includes(value);
  const press = (value: Value) => {
    if (choice.mode === "single") {
      choice.onSelect(value);
      onDismiss();
    } else {
      choice.onSelect(
        choice.selected.includes(value)
          ? choice.selected.filter((chosen) => chosen !== value)
          : [...choice.selected, value],
      );
    }
  };
  const rows = [
    ...(choice.mode === "single" && choice.noneLabel !== undefined
      ? [
          <OptionRow
            key="none"
            label={choice.noneLabel}
            selected={choice.selected === null}
            onPress={() => {
              choice.onSelect(null);
              onDismiss();
            }}
          />,
        ]
      : []),
    ...options.map((option) => (
      <OptionRow
        key={option.value}
        label={option.label}
        selected={isSelected(option.value)}
        onPress={() => press(option.value)}
        testID={testID ? `${testID}-${option.value}` : undefined}
      />
    )),
  ];

  return (
    <Modal
      visible={isPresented}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onDismiss}
    >
      <View testID={testID} className="flex-1 bg-surface">
        <View className="flex-row flex-wrap items-center justify-between gap-x-4 px-gutter pt-4 pb-2">
          <AppText variant="headline" accessibilityRole="header" className="shrink">
            {title}
          </AppText>
          <Button label="Done" variant="plain" onPress={onDismiss} />
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          {rows.map((row, index) => (
            <Fragment key={row.key}>
              {index > 0 ? (
                <View
                  className="ml-gutter"
                  style={{ height: StyleSheet.hairlineWidth, backgroundColor: separator }}
                />
              ) : null}
              {row}
            </Fragment>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}
