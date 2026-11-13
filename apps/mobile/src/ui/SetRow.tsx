import { setBadge, type SetType } from "@svett/core";
import { Pressable, View } from "react-native";

import { useColor, useIsAccessibilityTextSize } from "../design/hooks";
import { SET_TYPE_COLOR } from "../design/tokens";
import { AppText } from "./AppText";
import { EntryField } from "./NumberEntry";
import { Icon } from "./Icon";

export type SetField = "weight" | "reps";

export type SetRowProps = {
  readonly setType: SetType;
  /** The set's number among the exercise's normal sets. */
  readonly normalSetNumber: number;
  /** The same set last time, already formatted, or null when there was none. */
  readonly previous: string | null;
  readonly weight: string;
  readonly reps: string;
  readonly weightPlaceholder?: string;
  readonly repsPlaceholder?: string;
  readonly done: boolean;
  readonly focusedField?: SetField;
  readonly onPressSetType: () => void;
  readonly onPressField: (field: SetField) => void;
  readonly onToggleDone: () => void;
};

const COLUMN = { set: "min-w-11", weight: "min-w-20", reps: "min-w-16", done: "w-11" } as const;

/** The column titles above a run of set rows. Hidden from VoiceOver, since each row reads its own labels. */
export function SetRowHeader() {
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
      <AppText variant="caption1" tone="secondary" className={`${COLUMN.weight} text-center`}>
        KG
      </AppText>
      <AppText variant="caption1" tone="secondary" className={`${COLUMN.reps} text-center`}>
        REPS
      </AppText>
      <View className={COLUMN.done} />
    </View>
  );
}

/**
 * One set as the logger shows it. It holds no state: the caller passes the
 * values and handles each press. At accessibility text sizes the fields move
 * to a second line.
 */
export function SetRow(props: SetRowProps) {
  const stacked = useIsAccessibilityTextSize();
  const badge = setBadge(props.setType, props.normalSetNumber);
  const badgeColor = useColor(SET_TYPE_COLOR[props.setType]);

  const setButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge.label}
      accessibilityHint="Changes the set type"
      onPress={props.onPressSetType}
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

  const fields = (
    <>
      <View className={stacked ? "flex-1" : COLUMN.weight}>
        <EntryField
          label={`${badge.label}, weight`}
          value={props.weight}
          placeholder={props.weightPlaceholder}
          unit={stacked ? "kg" : undefined}
          focused={props.focusedField === "weight"}
          onPress={() => props.onPressField("weight")}
        />
      </View>
      <View className={stacked ? "flex-1" : COLUMN.reps}>
        <EntryField
          label={`${badge.label}, reps`}
          value={props.reps}
          placeholder={props.repsPlaceholder}
          unit={stacked ? "reps" : undefined}
          focused={props.focusedField === "reps"}
          onPress={() => props.onPressField("reps")}
        />
      </View>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`${badge.label} done`}
        accessibilityState={{ checked: props.done }}
        onPress={props.onToggleDone}
        className={`min-h-target items-center justify-center ${COLUMN.done}`}
      >
        <View className={`rounded-lg p-1.5 ${props.done ? "bg-success" : "bg-control"}`}>
          <Icon
            name="checkmark"
            color={props.done ? "surface" : "tertiary-label"}
            size={16}
            weight="bold"
          />
        </View>
      </Pressable>
    </>
  );

  return (
    <View className={`rounded-field px-3 py-1 ${props.done ? "bg-success-fill" : ""}`}>
      {stacked ? (
        <View className="gap-2 py-1">
          <View className="flex-row items-center gap-2">
            {setButton}
            {previous}
          </View>
          <View className="flex-row items-center gap-2">{fields}</View>
        </View>
      ) : (
        <View className="flex-row items-center gap-2">
          {setButton}
          {previous}
          {fields}
        </View>
      )}
    </View>
  );
}
