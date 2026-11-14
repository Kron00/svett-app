import type { LinkingOptions } from "@react-navigation/native";

import type { RootStackParamList } from "./navigation";

// The scripts in scripts/sim/ open screens through these links, such as
// svett://gallery?sheet=open, svett://exercises?q=bench, svett://progress/muscles,
// svett://chatgpt, svett://coach?ask=..., svett://train, svett://routine/<id>, svett://train/workout and
// svett://train/workout/exercises?q=plank, because agent-device refuses taps in screen
// content on iOS 27. It reads UIKit's touch-transparent floating bar containers as
// toolbars that cover the whole screen. scripts/sim/data.sh reaches export and import
// the same way, through svett://data, svett://import?file=<name> and
// svett://imports/<id>/undo. scripts/sim/hevy.sh adds &kind=hevy for a Hevy CSV.
// scripts/sim/tools.sh opens svett://settings/workout and svett://tools/plates?kg=100.
export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["svett://"],
  filter: (url) => !url.includes("expo-development-client"),
  config: {
    initialRouteName: "Tabs",
    screens: {
      Tabs: {
        screens: {
          Progress: "progress",
          Train: "train",
          Coach: { screens: { CoachRoot: "coach" } },
        },
      },
      Gallery: "gallery",
      ChatGPT: "chatgpt",
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
    },
  },
};
