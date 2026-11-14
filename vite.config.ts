import { defineConfig } from "vite-plus";

const GENERATED = [
  "node_modules",
  "dist",
  "pnpm-lock.yaml",
  "apps/mobile/ios/**",
  "apps/mobile/.expo/**",
  "apps/mobile/uniwind-types.d.ts",
  "docs/plan.html",
  "research/**",
];

export default defineConfig({
  fmt: {
    ignorePatterns: GENERATED,
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: GENERATED,
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      // React Navigation takes icons and headers as render props.
      "react/no-unstable-nested-components": ["error", { allowAsProps: true }],
      // expo-status-bar's `style` is a string enum, not a style object.
      "react/style-prop-object": ["error", { allow: ["StatusBar"] }],
    },
    overrides: [
      {
        // The app runs on the Hermes that React Native 0.88.1 pins (260318099.0.5), which
        // lacks these newer APIs. Tests run on Node, which has them, so they pass while the
        // app throws as it loads. After a Hermes bump, check this list against
        // include/hermes/VM/PredefinedStrings.def and lib/VM/JSLib/Intl.cpp at the new tag.
        files: ["apps/mobile/**", "packages/core/src/**", "packages/tools/**"],
        rules: {
          "unicorn/no-array-sort": "off",
          "no-restricted-properties": [
            "error",
            {
              property: "toSorted",
              message: "Hermes has no Array.prototype.toSorted. Sort a copy: [...array].sort().",
            },
            {
              object: "Array",
              property: "fromAsync",
              message: "Hermes has no Array.fromAsync.",
            },
            ...["resize", "transfer", "transferToFixedLength"].map((property) => ({
              property,
              message: "Hermes has no resizable or transferable ArrayBuffer.",
            })),
            ...["fromBase64", "toBase64", "fromHex", "toHex", "setFromBase64", "setFromHex"].map(
              (property) => ({
                property,
                message: "Hermes has no Uint8Array base64 or hex methods.",
              }),
            ),
            ...["getOrInsert", "getOrInsertComputed"].map((property) => ({
              property,
              message: "Hermes has no Map getOrInsert.",
            })),
            { object: "Math", property: "f16round", message: "Hermes has no Math.f16round." },
            ...[
              "PluralRules",
              "RelativeTimeFormat",
              "ListFormat",
              "Segmenter",
              "DisplayNames",
              "DurationFormat",
              "Locale",
            ].map((property) => ({
              object: "Intl",
              property,
              message: `Hermes has only Intl.Collator, DateTimeFormat and NumberFormat, not Intl.${property}.`,
            })),
            { object: "RegExp", property: "escape", message: "Hermes has no RegExp.escape." },
            ...[
              "Temporal",
              "Float16Array",
              "DisposableStack",
              "AsyncDisposableStack",
              "SuppressedError",
            ].map((property) => ({
              object: "globalThis",
              property,
              message: `Hermes has no ${property}.`,
            })),
          ],
          "no-restricted-globals": [
            "error",
            ...[
              "Temporal",
              "Float16Array",
              "DisposableStack",
              "AsyncDisposableStack",
              "SuppressedError",
            ].map((name) => ({ name, message: `Hermes has no ${name}.` })),
          ],
        },
      },
      {
        files: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "no-restricted-properties": "off", "no-restricted-globals": "off" },
      },
    ],
  },
});
