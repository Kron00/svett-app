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
        // The app runs on Hermes, which has no ES2023 copying array methods. Node has
        // them, so tests pass while the app fails as it loads.
        files: ["apps/mobile/src/**", "packages/core/src/**", "packages/tools/src/**"],
        rules: {
          "unicorn/no-array-sort": "off",
          "unicorn/no-array-reverse": "off",
          "no-restricted-properties": [
            "error",
            ...["toSorted", "toReversed", "toSpliced"].map((property) => ({
              property,
              message:
                "Hermes has no ES2023 copying array methods. Copy with [...array], then sort, reverse or splice.",
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
