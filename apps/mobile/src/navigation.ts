import type { NavigatorScreenParams } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import type { Tab } from "./tabs";

export type TabParamList = { readonly [name in Tab["name"]]: undefined };

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
  Account: undefined;
  OwnProfile: undefined;
  /** `username` fills in the field, for links such as svett://profile/edit?username=anna. */
  EditProfile: { username?: string } | undefined;
  FollowRequests: undefined;
  People: { q?: string } | undefined;
  Profile: { username: string };
  /** `list` is followers or following, parsed by the screen. */
  Connections: { username: string; list: string };
};

export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
