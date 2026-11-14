import "../global.css";

import {
  getFocusedRouteNameFromRoute,
  type LinkingOptions,
  NavigationContainer,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";

import { ChatGPTScreen } from "./chatgpt/ChatGPTScreen";
import { PhoneChecksScreen } from "./checks/PhoneChecksScreen";
import { useNavigationTheme } from "./design/hooks";
import { ExerciseDetailScreen } from "./exercises/ExerciseDetailScreen";
import { EditExerciseScreen, NewExerciseScreen } from "./exercises/ExerciseFormScreen";
import { ExerciseLibraryScreen, NewExerciseButton } from "./exercises/ExerciseLibraryScreen";
import { GalleryScreen } from "./gallery/GalleryScreen";
import type { RootStackParamList } from "./navigation";
import { ExerciseProgressScreen } from "./progress/ExerciseProgressScreen";
import { ExercisesScreen } from "./progress/ExercisesScreen";
import { MeasurementsScreen } from "./progress/MeasurementsScreen";
import { MuscleSetsScreen } from "./progress/MuscleSetsScreen";
import { CalendarScreen } from "./progress/CalendarScreen";
import { SetEditScreen } from "./progress/SetEditScreen";
import { WorkoutScreen } from "./progress/WorkoutScreen";
import { RoutineDetailScreen } from "./routines/RoutineDetailScreen";
import { EditRoutineScreen, NewRoutineScreen } from "./routines/RoutineEditorScreen";
import { SetTargetScreen } from "./routines/SetTargetScreen";
import { TabNavigator } from "./TabNavigator";
import { DataScreen } from "./transfer/DataScreen";
import { ImportPreviewScreen } from "./transfer/ImportPreviewScreen";
import { UndoImportScreen } from "./transfer/UndoImportScreen";
import { reloadWorkout } from "./workout/store";
import { WorkoutScreen as ActiveWorkoutScreen } from "./workout/WorkoutScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

// The scripts in scripts/sim/ open screens through these links, such as
// svett://gallery?sheet=open, svett://exercises?q=bench, svett://progress/muscles,
// svett://chatgpt, svett://train, svett://routine/<id>, svett://train/workout and
// svett://train/workout/exercises?q=plank, because agent-device refuses taps in screen
// content on iOS 27. It reads UIKit's touch-transparent floating bar containers as
// toolbars that cover the whole screen. scripts/sim/data.sh reaches export and import
// the same way, through svett://data, svett://import?file=<name> and
// svett://imports/<id>/undo.
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["svett://"],
  filter: (url) => !url.includes("expo-development-client"),
  config: {
    initialRouteName: "Tabs",
    screens: {
      Tabs: { screens: { Progress: "progress", Train: "train" } },
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
    },
  },
};

// A workout left in progress, even by an app that was killed, shows above the tabs at launch.
void reloadWorkout();

export default function App() {
  return (
    <NavigationContainer theme={useNavigationTheme()} linking={linking}>
      <StatusBar style="auto" />
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen
          name="Tabs"
          component={TabNavigator}
          // A pushed screen's back button names the tab it came from, such as "Train".
          options={({ route }) => ({ title: getFocusedRouteNameFromRoute(route) ?? "Home" })}
        />
        <Stack.Screen
          name="Gallery"
          component={GalleryScreen}
          options={{ headerShown: true, title: "Design gallery", headerLargeTitle: true }}
        />
        <Stack.Screen
          name="ChatGPT"
          component={ChatGPTScreen}
          options={{ headerShown: true, title: "ChatGPT" }}
        />
        <Stack.Screen
          name="Exercises"
          component={ExerciseLibraryScreen}
          options={({ navigation }) => ({
            headerShown: true,
            title: "Exercises",
            headerLargeTitle: true,
            headerRight: () => (
              <NewExerciseButton onPress={() => navigation.navigate("NewExercise")} />
            ),
          })}
        />
        <Stack.Screen
          name="Exercise"
          component={ExerciseDetailScreen}
          options={{ headerShown: true, title: "" }}
        />
        <Stack.Screen
          name="NewExercise"
          component={NewExerciseScreen}
          options={{ headerShown: true, title: "New exercise" }}
        />
        <Stack.Screen
          name="EditExercise"
          component={EditExerciseScreen}
          options={{ headerShown: true, title: "Edit exercise" }}
        />
        <Stack.Screen
          name="PickExercise"
          component={ExerciseLibraryScreen}
          options={{ headerShown: true, title: "Add exercise", headerLargeTitle: true }}
        />
        <Stack.Screen
          name="Routine"
          component={RoutineDetailScreen}
          options={{ headerShown: true, title: "" }}
        />
        <Stack.Screen
          name="NewRoutine"
          component={NewRoutineScreen}
          options={{ headerShown: true, title: "New routine" }}
        />
        <Stack.Screen
          name="EditRoutine"
          component={EditRoutineScreen}
          options={{ headerShown: true, title: "Edit routine" }}
        />
        <Stack.Screen
          name="SetTarget"
          component={SetTargetScreen}
          options={({ route }) => ({
            headerShown: true,
            presentation: "modal",
            title: `Set ${Number(route.params.set) + 1}`,
          })}
        />
        <Stack.Screen
          name="ActiveWorkout"
          component={ActiveWorkoutScreen}
          options={{ headerShown: true, title: "Workout" }}
        />
        <Stack.Screen
          name="AddWorkoutExercise"
          component={ExerciseLibraryScreen}
          options={{ headerShown: true, title: "Add exercise", headerLargeTitle: true }}
        />
        <Stack.Screen
          name="ReplaceWorkoutExercise"
          component={ExerciseLibraryScreen}
          options={{ headerShown: true, title: "Replace exercise", headerLargeTitle: true }}
        />
        <Stack.Screen
          name="PhoneChecks"
          component={PhoneChecksScreen}
          options={{ headerShown: true, title: "Phone checks" }}
        />
        <Stack.Screen
          name="ProgressExercises"
          component={ExercisesScreen}
          options={{ headerShown: true, title: "Exercises" }}
        />
        <Stack.Screen
          name="ExerciseProgress"
          component={ExerciseProgressScreen}
          options={{ headerShown: true, title: "Exercise" }}
        />
        <Stack.Screen
          name="MuscleSets"
          component={MuscleSetsScreen}
          options={{ headerShown: true, title: "Muscles" }}
        />
        <Stack.Screen
          name="Measurements"
          component={MeasurementsScreen}
          options={{ headerShown: true, title: "Body measurements" }}
        />
        <Stack.Screen
          name="Workout"
          component={WorkoutScreen}
          options={{ headerShown: true, title: "Workout", headerBackTitle: "History" }}
        />
        <Stack.Screen
          name="SetEdit"
          component={SetEditScreen}
          options={{ headerShown: true, title: "Edit set", presentation: "modal" }}
        />
        <Stack.Screen
          name="Calendar"
          component={CalendarScreen}
          options={{ headerShown: true, title: "Calendar" }}
        />
        <Stack.Screen
          name="Data"
          component={DataScreen}
          options={{ headerShown: true, title: "Your data", headerLargeTitle: true }}
        />
        <Stack.Screen
          name="ImportPreview"
          component={ImportPreviewScreen}
          options={{ headerShown: true, title: "Import" }}
        />
        <Stack.Screen
          name="UndoImport"
          component={UndoImportScreen}
          options={{ headerShown: true, title: "Undo import" }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
