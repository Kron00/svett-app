import type { LinkingOptions } from "@react-navigation/native";

import type { RootStackParamList } from "./navigation";

// The scripts in scripts/sim/ open screens through these links, such as
// svett://gallery?sheet=open, svett://exercises?q=bench, svett://progress/muscles and
// svett://chatgpt and svett://account,
// because agent-device refuses taps in screen content on iOS 27. It reads UIKit's
// touch-transparent floating bar containers as toolbars that cover the whole screen.
// scripts/sim/data.sh reaches export and import the same way, through svett://data,
// svett://import?file=<name> and svett://imports/<id>/undo. scripts/sim/hevy.sh
// adds &kind=hevy for a Hevy CSV. scripts/sim/social.sh opens svett://profile,
// svett://profile/edit?username=<name>, svett://people?q=<prefix>, svett://people/<name>,
// svett://people/<name>/followers and svett://profile/requests.
export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["svett://"],
  filter: (url) => !url.includes("expo-development-client"),
  config: {
    initialRouteName: "Tabs",
    screens: {
      Tabs: { screens: { Progress: "progress" } },
      Gallery: "gallery",
      ChatGPT: "chatgpt",
      Account: "account",
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
      EditProfile: "profile/edit",
      FollowRequests: "profile/requests",
      OwnProfile: "profile",
      Connections: "people/:username/:list",
      Profile: "people/:username",
      People: "people",
    },
  },
};
