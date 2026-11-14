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
        // The app runs on the Hermes that React Native 0.88.1 pins, which lacks these
        // newer APIs. Tests run on Node, which has them, so they pass while the app
        // throws as it loads.
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
          ],
        },
      },
      {
        files: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "no-restricted-properties": "off" },
      },
    ],
  },
});
