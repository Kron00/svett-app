import "../global.css";

import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { type LinkingOptions, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { SymbolView } from "expo-symbols";

import { WorkoutCounts } from "./data/WorkoutCounts";
import { PhoneChecksScreen } from "./checks/PhoneChecksScreen";
import { useNavigationTheme } from "./design/hooks";
import { DesignGalleryRow } from "./gallery/DesignGalleryRow";
import { GalleryScreen } from "./gallery/GalleryScreen";
import type { RootStackParamList } from "./navigation";
import { PhoneChecksRow } from "./PhoneChecksRow";
import { PlaceholderScreen } from "./PlaceholderScreen";
import { TABS } from "./tabs";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator();

// scripts/sim/gallery.sh opens svett://gallery, and svett://gallery?sheet=open
// for the sheet, because agent-device refuses taps in screen content on iOS 27.
// It reads UIKit's touch-transparent floating bar containers as toolbars that
// cover the whole screen.
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["svett://"],
  filter: (url) => !url.includes("expo-development-client"),
  config: { initialRouteName: "Tabs", screens: { Gallery: "gallery" } },
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
              {tab.name === "Progress" ? <WorkoutCounts /> : null}
              {tab.name === "You" ? (
                <>
                  <PhoneChecksRow />
                  <DesignGalleryRow />
                </>
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
        <Stack.Screen name="Tabs" component={TabNavigator} />
        <Stack.Screen
          name="Gallery"
          component={GalleryScreen}
          options={{ headerShown: true, title: "Design gallery", headerLargeTitle: true }}
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
