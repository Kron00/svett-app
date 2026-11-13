import { SegmentedControl as NativeSegmentedControl } from "@expo/ui/community/segmented-control";

export type SegmentedOption<Value extends string> = {
  readonly value: Value;
  readonly label: string;
};

/** The native SwiftUI segmented picker, typed by its option values. */
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
