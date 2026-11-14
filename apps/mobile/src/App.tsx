import "../global.css";

import {
  getFocusedRouteNameFromRoute,
  type LinkingOptions,
  NavigationContainer,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";

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
import { TabNavigator } from "./TabNavigator";

const Stack = createNativeStackNavigator<RootStackParamList>();

// The scripts in scripts/sim/ open screens through these links, such as
// svett://gallery?sheet=open, svett://exercises?q=bench and svett://progress/muscles,
// because agent-device refuses taps in screen content on iOS 27. It reads UIKit's
// touch-transparent floating bar containers as toolbars that cover the whole screen.
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["svett://"],
  filter: (url) => !url.includes("expo-development-client"),
  config: {
    initialRouteName: "Tabs",
    screens: {
      Tabs: { screens: { Progress: "progress" } },
      Gallery: "gallery",
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
    },
  },
};

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
      </Stack.Navigator>
    </NavigationContainer>
  );
}
