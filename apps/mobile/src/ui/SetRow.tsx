import { setBadge, type SetType } from "@svett/core";
import { Pressable, View } from "react-native";

import { useColor, useIsAccessibilityTextSize } from "../design/hooks";
import { SET_TYPE_COLOR } from "../design/tokens";
import { AppText } from "./AppText";
import { EntryField } from "./NumberEntry";
import { Icon } from "./Icon";

/** A value column of a set row, such as weight or reps. Times and distances need the wide one. */
export type SetRowColumn = { readonly title: string; readonly wide: boolean };

export const WEIGHT_AND_REPS: ReadonlyArray<SetRowColumn> = [
  { title: "KG", wide: true },
  { title: "REPS", wide: false },
];

export type SetRowField = {
  /** What VoiceOver calls the field after the set's own name, such as "weight". */
  readonly name: string;
  readonly value: string;
  /** Shown dimmed while the field is empty, such as last time's value. */
  readonly placeholder?: string;
  readonly unit?: string;
  readonly testID?: string;
};

export type SetRowProps = {
  readonly setType: SetType;
  /** The set's number among the exercise's normal sets. */
  readonly normalSetNumber: number;
  /** The same set last time, already formatted, or null when there was none. */
  readonly previous: string | null;
  readonly columns?: ReadonlyArray<SetRowColumn>;
  /** One field per column, in the same order. */
  readonly fields: ReadonlyArray<SetRowField>;
  readonly done: boolean;
  /** The field the keypad types into, by its place in `fields`. */
  readonly focusedField?: number;
  readonly onPressSetType: () => void;
  readonly onPressField: (field: number) => void;
  readonly onToggleDone: () => void;
  /** What VoiceOver reads for the done box, when the set's values should be part of it. */
  readonly doneLabel?: string;
  readonly testID?: string;
};

const COLUMN = { set: "min-w-11", wide: "min-w-20", narrow: "min-w-16", done: "w-11" } as const;

/** The column titles above a run of set rows. Hidden from VoiceOver, since each row reads its own labels. */
export function SetRowHeader({
  columns = WEIGHT_AND_REPS,
}: {
  readonly columns?: ReadonlyArray<SetRowColumn>;
}) {
  const stacked = useIsAccessibilityTextSize();
  if (stacked) return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row items-center gap-2 px-3"
    >
      <AppText variant="caption1" tone="secondary" className={`${COLUMN.set} text-center`}>
        SET
      </AppText>
      <AppText variant="caption1" tone="secondary" className="flex-1 text-center">
        PREVIOUS
      </AppText>
      {columns.map((column) => (
        <AppText
          key={column.title}
          variant="caption1"
          tone="secondary"
          className={`${column.wide ? COLUMN.wide : COLUMN.narrow} text-center`}
        >
          {column.title}
        </AppText>
      ))}
      <View className={COLUMN.done} />
    </View>
  );
}

/**
 * One set as the logger shows it. It holds no state: the caller passes the
 * values and handles each press. At accessibility text sizes the fields move
 * below the set's badge, and a weight, time or distance takes a line of its own.
 */
export function SetRow({ columns = WEIGHT_AND_REPS, ...props }: SetRowProps) {
  const stacked = useIsAccessibilityTextSize();
  const badge = setBadge(props.setType, props.normalSetNumber);
  const badgeColor = useColor(SET_TYPE_COLOR[props.setType]);

  const setButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge.label}
      accessibilityHint="Changes the set type"
      onPress={props.onPressSetType}
      testID={props.testID === undefined ? undefined : `${props.testID}-type`}
      className={`min-h-target items-center justify-center ${COLUMN.set}`}
    >
      <AppText variant="headline" numeric style={{ color: badgeColor }}>
        {badge.text}
      </AppText>
    </Pressable>
  );

  const previous = (
    <AppText
      variant="subheadline"
      tone="secondary"
      accessibilityLabel={`Previous, ${props.previous ?? "none"}`}
      className={stacked ? "flex-1" : "flex-1 text-center"}
    >
      {props.previous ?? "-"}
    </AppText>
  );

  const field = (index: number) => {
    const entry = props.fields[index]!;
    return (
      <View
        key={entry.name}
        className={stacked ? "flex-1" : columns[index]?.wide ? COLUMN.wide : COLUMN.narrow}
      >
        <EntryField
          label={`${badge.label}, ${entry.name}`}
          value={entry.value}
          placeholder={entry.placeholder}
          unit={stacked ? entry.unit : undefined}
          focused={props.focusedField === index}
          onPress={() => props.onPressField(index)}
          testID={entry.testID}
        />
      </View>
    );
  };

  const doneBox = (
    <Pressable
      key="done"
      accessibilityRole="checkbox"
      accessibilityLabel={props.doneLabel ?? `${badge.label} done`}
      accessibilityState={{ checked: props.done }}
      onPress={props.onToggleDone}
      testID={props.testID}
      className={`min-h-target items-center justify-center ${COLUMN.done}`}
    >
      <View className={`rounded-lg p-1.5 ${props.done ? "bg-success" : "bg-control"}`}>
        <Icon
          name="checkmark"
          color={props.done ? "surface" : "secondary-label"}
          size={16}
          weight="bold"
        />
      </View>
    </Pressable>
  );

  const indices = props.fields.map((_, index) => index);
  if (!stacked) {
    return (
      <View className={`rounded-field px-3 py-1 ${props.done ? "bg-success-fill" : ""}`}>
        <View className="flex-row items-center gap-2">
          {setButton}
          {previous}
          {indices.map(field)}
          {doneBox}
        </View>
      </View>
    );
  }

  // A weight, time or distance with its unit, such as "132.28 lb", wraps beside another field at
  // these sizes, so each gets the full width. Reps, RPE and the done box share the last line.
  const lines = indices.filter((index) => columns[index]?.wide).map((index) => [field(index)]);
  const narrow = indices.filter((index) => !columns[index]?.wide).map(field);
  const last = lines.at(-1);
  if (narrow.length === 0 && last !== undefined) last.push(doneBox);
  else lines.push([...narrow, doneBox]);

  return (
    <View className={`rounded-field px-3 py-1 ${props.done ? "bg-success-fill" : ""}`}>
      <View className="gap-2 py-1">
        <View className="flex-row items-center gap-2">
          {setButton}
          {previous}
        </View>
        {lines.map((line, index) => (
          <View key={index} testID="set-row-line" className="flex-row items-center gap-2">
            {line}
          </View>
        ))}
      </View>
    </View>
  );
}
