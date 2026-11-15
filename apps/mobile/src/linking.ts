import type { LinkingOptions } from "@react-navigation/native";
import { Linking, Settings } from "react-native";

import type { RootStackParamList } from "./navigation";

// The scripts in scripts/sim/ open screens through these links, such as
// svett://gallery?sheet=open, svett://exercises?q=bench, svett://progress/muscles,
// svett://chatgpt, svett://account, svett://coach?ask=..., svett://proposal/<id>,
// svett://train, svett://routine/<id>, svett://train/workout and
// svett://train/workout/exercises?q=plank, because agent-device refuses taps in screen
// content on iOS 27. It reads UIKit's touch-transparent floating bar containers as
// toolbars that cover the whole screen. scripts/sim/data.sh reaches export and import
// the same way, through svett://data, svett://import?file=<name> and
// svett://imports/<id>/undo. scripts/sim/hevy.sh adds &kind=hevy for a Hevy CSV.
// scripts/sim/health.sh uses svett://health-import?file=<name> and
// svett://manual?kind=...&duration=..., which fills manual entry's fields.
// scripts/sim/tools.sh opens svett://settings/workout and svett://tools/plates?kg=100.
// scripts/sim/social.sh opens svett://profile, svett://profile/edit?username=<name>,
// svett://people?q=<prefix>, svett://people/<name>, svett://people/<name>/followers and
// svett://profile/requests. scripts/sim/feed.sh opens svett://feed, svett://post/<social id>
// and svett://inbox. scripts/sim/connected-apps.sh opens svett://connected-apps.
//
// The launch argument `-svettLink <link>` opens svett on that link's screen, as if the link had
// launched it. scripts/sim/startup.sh launches with `-svettLink svett://train`, so the first
// screen is the Train tab and the cold start it times has no wait for a later link in it.
const launchLink = (value: unknown): string | null =>
  typeof value === "string" && value.startsWith("svett://") ? value : null;

export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["svett://"],
  filter: (url) => !url.includes("expo-development-client"),
  getInitialURL: () =>
    launchLink(Settings.get("svettLink")) ??
    // React Navigation's own default, which gives up after 150 ms because of
    // https://github.com/facebook/react-native/issues/25675.
    Promise.race([
      Linking.getInitialURL(),
      new Promise<undefined>((resolve) => setTimeout(resolve, 150)),
    ]),
  config: {
    initialRouteName: "Tabs",
    screens: {
      Tabs: {
        screens: {
          Progress: "progress",
          Home: "feed",
          Train: "train",
          Coach: { screens: { CoachRoot: "coach" } },
        },
      },
      Gallery: "gallery",
      RecordCardio: "record",
      Activity: "activity/:id",
      ChatGPT: "chatgpt",
      Account: "account",
      ConnectedApps: "connected-apps",
      Proposal: "proposal/:id",
      NewExercise: "exercises/new",
      Exercises: "exercises",
      EditExercise: "exercise/:id/edit",
      Exercise: "exercise/:id",
      ProgressExercises: "progress/exercises",
      ExerciseProgress: "progress/exercise/:exerciseId",
      MuscleSets: "progress/muscles",
      Measurements: "progress/measurements",
      Workout: "workout/:id",
      SetEdit: "workout/:activityId/set/:setId",
      Calendar: "calendar",
      Data: "data",
      ImportPreview: "import",
      UndoImport: "imports/:importBatchId/undo",
      NewRoutine: "routines/new",
      PickExercise: "routines/new/exercises",
      EditRoutine: "routine/:id/edit",
      Routine: "routine/:id",
      ActiveWorkout: "train/workout",
      AddWorkoutExercise: "train/workout/exercises",
      ReplaceWorkoutExercise: "train/workout/exercise/:exercise/replace",
      WarmUp: "train/workout/exercise/:exercise/warm-up",
      Plates: "tools/plates",
      WorkoutSettings: "settings/workout",
      HealthImport: "health-import",
      ManualCardio: "manual",
      EditProfile: "profile/edit",
      FollowRequests: "profile/requests",
      Blocks: "profile/blocked",
      OwnProfile: "profile",
      Connections: "people/:username/:list",
      Profile: "people/:username",
      People: "people",
      Post: "post/:id",
      Inbox: "inbox",
    },
  },
};
