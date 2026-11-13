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
  },
});
