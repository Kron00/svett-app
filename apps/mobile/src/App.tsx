import "../global.css";

import { getFocusedRouteNameFromRoute, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";

import { ChatGPTScreen } from "./chatgpt/ChatGPTScreen";
import { PhoneChecksScreen } from "./checks/PhoneChecksScreen";
import { markLaunchOnNextFrame } from "./data/launch-timing";
import { useNavigationTheme } from "./design/hooks";
import { ExerciseDetailScreen } from "./exercises/ExerciseDetailScreen";
import { EditExerciseScreen, NewExerciseScreen } from "./exercises/ExerciseFormScreen";
import { ExerciseLibraryScreen, NewExerciseButton } from "./exercises/ExerciseLibraryScreen";
import { GalleryScreen } from "./gallery/GalleryScreen";
import { linking } from "./linking";
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
import { restoreRestTimer } from "./workout/rest";
import { currentWorkout, reloadWorkout, workoutState } from "./workout/store";
import { PlatesScreen } from "./tools/PlatesScreen";
import { WarmUpScreen } from "./tools/WarmUpScreen";
import { WorkoutSettingsScreen } from "./tools/WorkoutSettingsScreen";
import { WorkoutScreen as ActiveWorkoutScreen } from "./workout/WorkoutScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

// A workout left in progress, even by an app that was killed, shows above the tabs at launch,
// with the rest that was running. A workout that could not be read leaves the rest as kept.
void reloadWorkout().then(() => {
  if (workoutState().status === "ready") void restoreRestTimer(currentWorkout());
});

export default function App() {
  return (
    <NavigationContainer
      theme={useNavigationTheme()}
      linking={linking}
      onReady={() => markLaunchOnNextFrame("screen")}
    >
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
          name="WarmUp"
          component={WarmUpScreen}
          options={{ headerShown: true, title: "Warm-up sets", headerLargeTitle: true }}
        />
        <Stack.Screen
          name="Plates"
          component={PlatesScreen}
          options={{ headerShown: true, title: "Plate calculator", headerLargeTitle: true }}
        />
        <Stack.Screen
          name="WorkoutSettings"
          component={WorkoutSettingsScreen}
          options={{ headerShown: true, title: "Units and plates", headerLargeTitle: true }}
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
