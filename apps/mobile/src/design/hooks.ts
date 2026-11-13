import { DarkTheme, DefaultTheme, type Theme } from "@react-navigation/native";
import { useColorScheme, useWindowDimensions } from "react-native";
import { useCSSVariable } from "uniwind";

import { ACCESSIBILITY_FONT_SCALE, type ColorToken } from "./tokens";

/** A token's value in the current appearance, for props that take a colour instead of a class. */
export function useColor(token: ColorToken): string {
  return String(useCSSVariable(`--color-${token}`));
}

/** True at the five accessibility text sizes, where rows stack instead of sitting side by side. */
export function useIsAccessibilityTextSize(): boolean {
  return useWindowDimensions().fontScale >= ACCESSIBILITY_FONT_SCALE;
}

/** Symbols grow with the text beside them, up to twice their size. */
export function useSymbolSize(size: number): number {
  return size * Math.min(2, Math.max(1, useWindowDimensions().fontScale));
}

/** React Navigation's colours, so headers and the tab bar use the same tokens as the screens. */
export function useNavigationTheme(): Theme {
  const base = useColorScheme() === "dark" ? DarkTheme : DefaultTheme;
  const primary = useColor("accent");
  const background = useColor("background");
  const card = useColor("surface");
  const text = useColor("label");
  const border = useColor("separator");
  const notification = useColor("destructive");
  return { ...base, colors: { primary, background, card, text, border, notification } };
}
