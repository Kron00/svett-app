/// <reference types="node" />
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { COLOR_TOKENS, type ColorToken, TEXT_STYLES, TINT_COLORS } from "./tokens";

const css = readFileSync(new URL("../../global.css", import.meta.url), "utf8");

const colors: Record<string, string> = Object.fromEntries(
  [...css.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6});/g)].map(([, name = "", value = ""]) => [
    name,
    value,
  ]),
);

const luminance = (hex: string): number => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.039_28 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string): number => {
  const [brighter, dimmer] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return ((brighter ?? 0) + 0.05) / ((dimmer ?? 0) + 0.05);
};

// WCAG AA asks 4.5:1 for text and 3:1 for icons and other graphics.
const TEXT = 4.5;
const GRAPHIC = 3;
const textColors: ReadonlyArray<ColorToken> = [
  "label",
  "secondary-label",
  "accent",
  "destructive",
  "success",
  "warning",
  "set-warm-up",
  "set-normal",
  "set-failure",
  "set-drop",
];
const graphicColors: ReadonlyArray<ColorToken> = [
  "tertiary-label",
  "sport-strength",
  "sport-run",
  "sport-ride",
  "sport-walk",
  "sport-hike",
  "sport-other",
];
const pairs: ReadonlyArray<readonly [ColorToken, ColorToken, number]> = [
  ...textColors.flatMap((token) => [
    [token, "background", TEXT] as const,
    [token, "surface", TEXT] as const,
  ]),
  ...graphicColors.map((token) => [token, "surface", GRAPHIC] as const),
  ["label", "control", TEXT],
  // An empty field shows the previous set's value as its placeholder, and an
  // unticked set shows its checkmark in the same colour.
  ["secondary-label", "control", TEXT],
  // Secondary buttons, and the checkmark on a segmented control row.
  ["accent", "control", TEXT],
  ["on-accent", "accent-fill", TEXT],
  ...TINT_COLORS.map((token) => ["on-tint", token, GRAPHIC] as const),
  ["destructive", "destructive-fill", TEXT],
  // A finished set's row takes the success fill, and its badge keeps the set type's colour.
  ["label", "success-fill", TEXT],
  ["surface", "success", GRAPHIC],
  ["set-warm-up", "success-fill", TEXT],
  ["set-failure", "success-fill", TEXT],
  ["set-drop", "success-fill", TEXT],
];

describe("colours", () => {
  it("defines exactly the tokens the code names", () => {
    expect(Object.keys(colors).toSorted()).toEqual(COLOR_TOKENS.toSorted());
  });

  it.each(pairs)("%s on %s reaches %d:1", (foreground, background, minimum) => {
    expect(contrast(colors[foreground] ?? "", colors[background] ?? "")).toBeGreaterThanOrEqual(
      minimum,
    );
  });
});

describe("text styles", () => {
  it.each(Object.entries(TEXT_STYLES))(
    "%s has a size and line height in global.css",
    (_, classes) => {
      const size = classes.split(" ")[0]?.replace(/^text-/, "");
      expect(css).toMatch(new RegExp(`--text-${size}: \\d+px;`));
      expect(css).toMatch(new RegExp(`--text-${size}--line-height: \\d+px;`));
    },
  );
});
