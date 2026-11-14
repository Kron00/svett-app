import type { CompositeNavigationProp, NavigatorScreenParams } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import type { Tab } from "./tabs";

export type TabParamList = { readonly [name in Exclude<Tab["name"], "Coach">]: undefined } & {
  readonly Coach: NavigatorScreenParams<CoachStackParamList> | undefined;
};

/** Link params are strings from outside. Each screen parses them with @svett/core. */
export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
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
  /** IDs come from deep links too, so screens parse them before use. */
  Workout: { id: string };
  SetEdit: { activityId: string; setId: string };
  /** A month such as "2026-10". Without one the calendar opens on this month. */
  Calendar: { month?: string } | undefined;
  Data: undefined;
  /**
   * `uri` is a picked file. `file` names a file in svett's documents, for svett://import links.
   * `kind` is hevy for Hevy's workout CSV, and a svett export otherwise.
   */
  ImportPreview: { uri?: string; file?: string; kind?: "svett" | "hevy" };
  UndoImport: { importBatchId: string };
  Routine: { id: string };
  NewRoutine: { title?: string; folder?: string } | undefined;
  EditRoutine: { id: string };
  /** The exercise library choosing exercises for the routine being edited. */
  PickExercise: { q?: string; muscle?: string; equipment?: string } | undefined;
  /** Exercise and set by their place in the routine being edited, from 0. */
  SetTarget: { exercise: string; set: string };
  /** The workout in progress. */
  ActiveWorkout: undefined;
  /** The exercise library choosing exercises to add to the workout in progress. */
  AddWorkoutExercise: { q?: string; muscle?: string; equipment?: string } | undefined;
  /** The exercise library choosing the exercise that takes the place of `exercise`, a workout exercise's ID. */
  ReplaceWorkoutExercise: { exercise: string; q?: string; muscle?: string; equipment?: string };
  Account: undefined;
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
