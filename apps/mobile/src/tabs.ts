import type { SymbolViewProps } from "expo-symbols";

type SymbolName = Extract<SymbolViewProps["name"], string>;

export type Tab = {
  readonly name: "Home" | "Train" | "Progress" | "Coach" | "You";
  readonly symbol: SymbolName;
  readonly summary: string;
};

export const TABS: ReadonlyArray<Tab> = [
  { name: "Home", symbol: "house.fill", summary: "Your timeline and this week at a glance." },
  {
    name: "Train",
    symbol: "dumbbell.fill",
    summary: "Workouts, routines and the exercise library.",
  },
  {
    name: "Progress",
    symbol: "chart.line.uptrend.xyaxis",
    summary: "History, records, charts and measurements.",
  },
  {
    name: "Coach",
    symbol: "bubble.left.and.bubble.right.fill",
    summary: "Chat with your coach.",
  },
  { name: "You", symbol: "person.crop.circle.fill", summary: "Profile, data and settings." },
];
