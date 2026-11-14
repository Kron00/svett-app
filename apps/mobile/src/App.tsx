import "../global.css";

import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { type LinkingOptions, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { SymbolView } from "expo-symbols";
import { View } from "react-native";

import { ChatGPTRow } from "./chatgpt/ChatGPTRow";
import { ChatGPTScreen } from "./chatgpt/ChatGPTScreen";
import { CoachScreen } from "./coach/CoachScreen";
import { WorkoutCounts } from "./data/WorkoutCounts";
import { PhoneChecksScreen } from "./checks/PhoneChecksScreen";
import { useNavigationTheme } from "./design/hooks";
import { DesignGalleryRow } from "./gallery/DesignGalleryRow";
import { GalleryScreen } from "./gallery/GalleryScreen";
import type { RootStackParamList, TabParamList } from "./navigation";
import { PhoneChecksRow } from "./PhoneChecksRow";
import { PlaceholderScreen } from "./PlaceholderScreen";
import { TABS } from "./tabs";
import { ListSection } from "./ui/List";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

// scripts/sim/gallery.sh opens svett://gallery, and svett://gallery?sheet=open
// for the sheet, scripts/sim/chatgpt.sh opens svett://chatgpt, and scripts/sim/coach.sh
// opens svett://coach?ask=..., because agent-device refuses taps in screen content on iOS 27.
// It reads UIKit's touch-transparent floating bar containers as toolbars that
// cover the whole screen.
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["svett://"],
  filter: (url) => !url.includes("expo-development-client"),
  config: {
    initialRouteName: "Tabs",
    screens: {
      Tabs: { screens: { Coach: "coach" } },
      Gallery: "gallery",
      ChatGPT: "chatgpt",
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
          {() =>
            tab.name === "Coach" ? (
              <CoachScreen />
            ) : (
              <PlaceholderScreen tab={tab}>
                {tab.name === "Progress" ? <WorkoutCounts /> : null}
                {tab.name === "You" ? (
                  <View className="mt-6 self-stretch">
                    <ListSection>
                      <ChatGPTRow />
                      <PhoneChecksRow />
                      <DesignGalleryRow />
                    </ListSection>
                  </View>
                ) : null}
              </PlaceholderScreen>
            )
          }
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
          name="ChatGPT"
          component={ChatGPTScreen}
          options={{ headerShown: true, title: "ChatGPT" }}
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
