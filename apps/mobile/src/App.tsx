import "../global.css";

import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { SymbolView } from "expo-symbols";
import { useColorScheme } from "react-native";

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
          {() => <PlaceholderScreen tab={tab} />}
        </Tabs.Screen>
      ))}
    </Tabs.Navigator>
  );
}

export default function App() {
  const scheme = useColorScheme();
  return (
    <NavigationContainer theme={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <StatusBar style="auto" />
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={TabNavigator} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
