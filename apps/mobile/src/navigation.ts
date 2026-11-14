import type { CompositeNavigationProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

/** Link params are strings from outside. Each screen parses them with @svett/core. */
export type RootStackParamList = {
  Tabs: undefined;
  Gallery: { sheet?: "open" } | undefined;
  PhoneChecks: undefined;
  ChatGPT: undefined;
  Exercises: { q?: string; muscle?: string; equipment?: string } | undefined;
  Exercise: { id: string };
  NewExercise:
    | { name?: string; muscle?: string; equipment?: string; category?: string }
    | undefined;
  EditExercise: { id: string };
  ProgressExercises: undefined;
  // Links carry these, so screens parse each parameter before they use it.
  ExerciseProgress: { exerciseId: string; range?: string };
  MuscleSets: { week?: string; muscle?: string } | undefined;
  Measurements: { kind?: string; range?: string; sheet?: "open" } | undefined;
};

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

/** The Coach tab's own stack. */
export type CoachStackParamList = {
  /** `ask` is a question svett://coach?ask=... sends as soon as the coach is ready. */
  CoachRoot: { ask?: string | undefined } | undefined;
};

export type CoachNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<CoachStackParamList, "CoachRoot">,
  RootNavigation
>;
