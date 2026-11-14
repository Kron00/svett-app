import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Pressable, StyleSheet, Switch, View } from "react-native";

import { useColor, useIsAccessibilityTextSize } from "../design/hooks";
import type { SymbolName, TintColor } from "../design/tokens";
import { AppText } from "./AppText";
import { Icon } from "./Icon";

/** A heading above a block of content, with an optional action such as "See all". */
export function SectionHeader({
  title,
  action,
}: {
  readonly title: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <View className="flex-row flex-wrap items-end justify-between gap-x-4 px-gutter">
      <AppText variant="title3" accessibilityRole="header" className="shrink">
        {title}
      </AppText>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          hitSlop={8}
          className="min-h-target justify-center"
        >
          <AppText tone="accent">{action.label}</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** An inset grouped list section: rows on one rounded card, separated by hairlines. */
export function ListSection({
  header,
  footer,
  children,
}: {
  readonly header?: string;
  readonly footer?: string;
  readonly children: ReactNode;
}) {
  const separator = useColor("separator");
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View className="gap-2">
      {header ? (
        <AppText variant="footnote" tone="secondary" accessibilityRole="header" className="px-8">
          {header}
        </AppText>
      ) : null}
      <View className="mx-gutter overflow-hidden rounded-card bg-surface">
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
      </View>
      {footer ? (
        <AppText variant="footnote" tone="secondary" className="px-8">
          {footer}
        </AppText>
      ) : null}
    </View>
  );
}

/** What sits at a row's trailing edge, which also decides what tapping the row does. */
export type RowTrailing =
  | { readonly type: "chevron"; readonly onPress: () => void }
  | {
      readonly type: "switch";
      readonly value: boolean;
      readonly onValueChange: (value: boolean) => void;
    }
  | {
      /** One choice among the rows of a section. The chosen row shows a checkmark. */
      readonly type: "check";
      readonly selected: boolean;
      readonly onPress: () => void;
    }
  | { readonly type: "none" };

const NO_TRAILING: RowTrailing = { type: "none" };

export type ListRowProps = {
  readonly title: string;
  readonly subtitle?: string;
  readonly value?: string;
  readonly icon?: { readonly symbol: SymbolName; readonly color: TintColor };
  readonly trailing?: RowTrailing;
  readonly testID?: string;
};

function RowIcon({ symbol, color }: { readonly symbol: SymbolName; readonly color: TintColor }) {
  return (
    <View className="rounded-lg p-1.5" style={{ backgroundColor: useColor(color) }}>
      <Icon name={symbol} color="on-tint" size={17} />
    </View>
  );
}

/**
 * One row of a list section. At accessibility text sizes the value moves under
 * the title, so neither is cut off.
 */
export function ListRow({
  title,
  subtitle,
  value,
  icon,
  trailing = NO_TRAILING,
  testID,
}: ListRowProps) {
  const stacked = useIsAccessibilityTextSize();
  const label = [title, subtitle, value].filter(Boolean).join(", ");
  const content = (
    <View className="min-h-target flex-row items-center gap-3 px-gutter py-3">
      {icon ? <RowIcon {...icon} /> : null}
      <View className={stacked ? "flex-1 gap-1" : "flex-1 flex-row items-center gap-3"}>
        <View className={stacked ? "" : "flex-1"}>
          <AppText>{title}</AppText>
          {subtitle ? (
            <AppText variant="subheadline" tone="secondary">
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {value ? (
          <AppText tone="secondary" className={stacked ? "" : "shrink text-right"}>
            {value}
          </AppText>
        ) : null}
      </View>
      {trailing.type === "chevron" ? (
        <Icon name="chevron.right" color="tertiary-label" size={14} weight="semibold" />
      ) : null}
      {trailing.type === "check" ? (
        <View className={trailing.selected ? "" : "opacity-0"}>
          <Icon name="checkmark" color="accent" size={17} weight="semibold" />
        </View>
      ) : null}
      {trailing.type === "switch" ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Switch value={trailing.value} onValueChange={trailing.onValueChange} />
        </View>
      ) : null}
    </View>
  );

  switch (trailing.type) {
    case "chevron":
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={trailing.onPress}
          testID={testID}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          {content}
        </Pressable>
      );
    case "switch":
      // The whole row toggles, which gives a far bigger target than the switch alone.
      return (
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel={label}
          accessibilityState={{ checked: trailing.value }}
          onPress={() => trailing.onValueChange(!trailing.value)}
          testID={testID}
        >
          {content}
        </Pressable>
      );
    case "check":
      return (
        <Pressable
          accessibilityRole="radio"
          accessibilityLabel={label}
          accessibilityState={{ checked: trailing.selected }}
          onPress={trailing.onPress}
          testID={testID}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          {content}
        </Pressable>
      );
    case "none":
      return (
        <View accessible accessibilityLabel={label} testID={testID}>
          {content}
        </View>
      );
  }
}
