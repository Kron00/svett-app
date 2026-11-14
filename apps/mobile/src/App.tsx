import "../global.css";

import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import {
  getFocusedRouteNameFromRoute,
  type LinkingOptions,
  NavigationContainer,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { SymbolView } from "expo-symbols";
import { View } from "react-native";

import { WorkoutCounts } from "./data/WorkoutCounts";
import { PhoneChecksScreen } from "./checks/PhoneChecksScreen";
import { useNavigationTheme } from "./design/hooks";
import { ExerciseDetailScreen } from "./exercises/ExerciseDetailScreen";
import { EditExerciseScreen, NewExerciseScreen } from "./exercises/ExerciseFormScreen";
import { ExerciseLibraryRow } from "./exercises/ExerciseLibraryRow";
import { ExerciseLibraryScreen, NewExerciseButton } from "./exercises/ExerciseLibraryScreen";
import { DesignGalleryRow } from "./gallery/DesignGalleryRow";
import { GalleryScreen } from "./gallery/GalleryScreen";
import type { RootStackParamList } from "./navigation";
import { PhoneChecksRow } from "./PhoneChecksRow";
import { PlaceholderScreen } from "./PlaceholderScreen";
import { TABS } from "./tabs";
import { ListSection } from "./ui/List";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator();

// The scripts in scripts/sim/ open screens through these links, such as
// svett://gallery?sheet=open and svett://exercises?q=bench, because agent-device
// refuses taps in screen content on iOS 27. It reads UIKit's touch-transparent
// floating bar containers as toolbars that cover the whole screen.
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["svett://"],
  filter: (url) => !url.includes("expo-development-client"),
  config: {
    initialRouteName: "Tabs",
    screens: {
      Gallery: "gallery",
      NewExercise: "exercises/new",
      Exercises: "exercises",
      EditExercise: "exercise/:id/edit",
      Exercise: "exercise/:id",
    },
  },
};

function TabNavigator() {
  return (
    <Tabs.Navigator>
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            tabBarIcon: ({ color, size }) => (
              <SymbolView name={tab.symbol} tintColor={color} size={size} />
            ),
          }}
        >
          {() => (
            <PlaceholderScreen tab={tab}>
              {tab.name === "Train" ? (
                <View className="mt-6 self-stretch">
                  <ListSection>
                    <ExerciseLibraryRow />
                  </ListSection>
                </View>
              ) : null}
              {tab.name === "Progress" ? <WorkoutCounts /> : null}
              {tab.name === "You" ? (
                <View className="mt-6 self-stretch">
                  <ListSection>
                    <PhoneChecksRow />
                    <DesignGalleryRow />
                  </ListSection>
                </View>
              ) : null}
            </PlaceholderScreen>
          )}
        </Tabs.Screen>
      ))}
    </Tabs.Navigator>
  );
}

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
      </Stack.Navigator>
    </NavigationContainer>
  );
}
