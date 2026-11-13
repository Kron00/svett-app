import "../global.css";

import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { SymbolView } from "expo-symbols";

import { WorkoutCounts } from "./data/WorkoutCounts";
import { useNavigationTheme } from "./design/hooks";
import { DesignGalleryRow } from "./gallery/DesignGalleryRow";
import { GalleryScreen } from "./gallery/GalleryScreen";
import { PlaceholderScreen } from "./PlaceholderScreen";
import { TABS } from "./tabs";

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

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
              {tab.name === "You" ? <DesignGalleryRow /> : null}
            </PlaceholderScreen>
          )}
        </Tabs.Screen>
      ))}
    </Tabs.Navigator>
  );
}

export default function App() {
  return (
    <NavigationContainer theme={useNavigationTheme()}>
      <StatusBar style="auto" />
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={TabNavigator} />
        <Stack.Screen
          name="Gallery"
          component={GalleryScreen}
          options={{ headerShown: true, title: "Design gallery", headerLargeTitle: true }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
