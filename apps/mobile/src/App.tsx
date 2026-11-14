import "../global.css";

import { getFocusedRouteNameFromRoute, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";

import { AccountProvider } from "./account/AccountProvider";
import { AccountScreen } from "./account/AccountScreen";
import { ChatGPTScreen } from "./chatgpt/ChatGPTScreen";
import { PhoneChecksScreen } from "./checks/PhoneChecksScreen";
import {
  ConnectionsScreen,
  EditProfileScreen,
  BlocksScreen,
  FollowRequestsScreen,
  PeopleScreen,
} from "./social/PeopleScreens";
import { OwnProfileScreen, ProfileScreen } from "./social/ProfileScreens";
import { useNavigationTheme } from "./design/hooks";
import { InboxScreen } from "./feed/InboxScreen";
import { PostScreen } from "./feed/PostScreen";
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
import { TabNavigator } from "./TabNavigator";
import { DataScreen } from "./transfer/DataScreen";
import { ImportPreviewScreen } from "./transfer/ImportPreviewScreen";
import { UndoImportScreen } from "./transfer/UndoImportScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <AccountProvider>
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
            name="Account"
            component={AccountScreen}
            options={{ headerShown: true, title: "Account" }}
          />
          <Stack.Screen
            name="OwnProfile"
            component={OwnProfileScreen}
            options={({ navigation }) => ({
              headerShown: true,
              title: "Profile",
              unstable_headerRightItems: () => [
                {
                  type: "button",
                  label: "Edit",
                  accessibilityLabel: "Edit profile",
                  identifier: "edit-profile",
                  onPress: () => navigation.navigate("EditProfile"),
                },
              ],
            })}
          />
          <Stack.Screen
            name="EditProfile"
            component={EditProfileScreen}
            options={{ headerShown: true, title: "Edit profile" }}
          />
          <Stack.Screen
            name="FollowRequests"
            component={FollowRequestsScreen}
            options={{ headerShown: true, title: "Follow requests" }}
          />
          <Stack.Screen
            name="Blocks"
            component={BlocksScreen}
            options={{ headerShown: true, title: "Blocked accounts" }}
          />
          <Stack.Screen
            name="People"
            component={PeopleScreen}
            options={{ headerShown: true, title: "Find people" }}
          />
          <Stack.Screen
            name="Profile"
            component={ProfileScreen}
            options={({ route }) => ({ headerShown: true, title: route.params.username })}
          />
          <Stack.Screen
            name="Connections"
            component={ConnectionsScreen}
            options={({ route }) => ({
              headerShown: true,
              title: route.params.list === "following" ? "Following" : "Followers",
            })}
          />
          <Stack.Screen
            name="Post"
            component={PostScreen}
            options={{ headerShown: true, title: "Post" }}
          />
          <Stack.Screen
            name="Inbox"
            component={InboxScreen}
            options={{ headerShown: true, title: "Inbox", headerLargeTitle: true }}
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
    </AccountProvider>
  );
}
