import type { ActivityKind, SetType } from "@svett/core";
import type { SymbolViewProps } from "expo-symbols";
import type { TextProps } from "react-native";

export type SymbolName = Extract<SymbolViewProps["name"], string>;

/** Every colour token in global.css. Classes use them as bg-<token> and text-<token>. */
export const COLOR_TOKENS = [
  "background",
  "surface",
  "control",
  "label",
  "secondary-label",
  "tertiary-label",
  "separator",
  "accent",
  "accent-fill",
  "on-accent",
  "on-tint",
  "destructive",
  "destructive-fill",
  "success",
  "success-fill",
  "warning",
  "set-warm-up",
  "set-normal",
  "set-failure",
  "set-drop",
  "sport-strength",
  "sport-run",
  "sport-ride",
  "sport-walk",
  "sport-hike",
  "sport-other",
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

/** Colours a symbol can sit on, as in a list row's icon. The symbol is drawn in on-tint. */
export const TINT_COLORS = [
  "accent",
  "set-warm-up",
  "set-normal",
  "set-failure",
  "set-drop",
  "sport-strength",
  "sport-run",
  "sport-ride",
  "sport-walk",
  "sport-hike",
  "sport-other",
] as const satisfies ReadonlyArray<ColorToken>;

export type TintColor = (typeof TINT_COLORS)[number];

export const SET_TYPE_COLOR: Readonly<Record<SetType, TintColor>> = {
  warm_up: "set-warm-up",
  normal: "set-normal",
  failure: "set-failure",
  drop: "set-drop",
};

export type Sport = {
  readonly label: string;
  readonly symbol: SymbolName;
  readonly color: TintColor;
};

export const SPORTS: Readonly<Record<ActivityKind, Sport>> = {
  strength: { label: "Strength", symbol: "dumbbell.fill", color: "sport-strength" },
  run: { label: "Run", symbol: "figure.run", color: "sport-run" },
  ride: { label: "Ride", symbol: "figure.outdoor.cycle", color: "sport-ride" },
  walk: { label: "Walk", symbol: "figure.walk", color: "sport-walk" },
  hike: { label: "Hike", symbol: "figure.hiking", color: "sport-hike" },
  other: { label: "Other", symbol: "figure.mixed.cardio", color: "sport-other" },
};

export type TextStyleName = NonNullable<TextProps["dynamicTypeRamp"]>;

/**
 * The iOS text styles. Each class sets the size at the default text size, and
 * the style's own name is its dynamicTypeRamp, so iOS scales it on Apple's curve.
 */
export const TEXT_STYLES: Readonly<Record<TextStyleName, string>> = {
  largeTitle: "text-large-title font-bold",
  title1: "text-title1 font-bold",
  title2: "text-title2 font-bold",
  title3: "text-title3 font-semibold",
  headline: "text-headline font-semibold",
  body: "text-body",
  callout: "text-callout",
  subheadline: "text-subheadline",
  footnote: "text-footnote",
  caption1: "text-caption1",
  caption2: "text-caption2",
};

/**
 * React Native's font scale at the smallest accessibility text size is about
 * 1.8, and at the largest standard size about 1.35. Layouts that set things
 * side by side stack them from here on, as UIKit does for accessibility sizes.
 */
export const ACCESSIBILITY_FONT_SCALE = 1.5;
