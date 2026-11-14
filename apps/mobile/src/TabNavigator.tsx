import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SymbolView } from "expo-symbols";
import { View } from "react-native";

import { AccountRow } from "./account/AccountRow";
import { ChatGPTRow } from "./chatgpt/ChatGPTRow";
import { CoachScreen } from "./coach/CoachScreen";
import { DesignGalleryRow } from "./gallery/DesignGalleryRow";
import type { TabParamList } from "./navigation";
import { PhoneChecksRow } from "./PhoneChecksRow";
import { PlaceholderScreen } from "./PlaceholderScreen";
import { ProgressScreen } from "./progress/ProgressScreen";
import { TrainScreen } from "./routines/TrainScreen";
import { type Tab, TABS } from "./tabs";
import { WorkoutSettingsRow } from "./tools/WorkoutSettingsRow";
import { DataRow } from "./transfer/DataRow";
import { ListSection } from "./ui/List";
import { WorkoutTabBar } from "./workout/WorkoutTabBar";

const Tabs = createBottomTabNavigator<TabParamList>();
const TabStack = createNativeStackNavigator();

function TabContent({ tab }: { readonly tab: Tab }) {
  if (tab.name === "Progress") return <ProgressScreen />;
  if (tab.name === "Coach") return <CoachScreen />;
  if (tab.name === "Train") return <TrainScreen />;
  return (
    <PlaceholderScreen tab={tab}>
      {tab.name === "You" ? (
        <View className="mt-6 self-stretch">
          <ListSection>
            <AccountRow />
            <ChatGPTRow />
            <DataRow />
            <WorkoutSettingsRow />
            <PhoneChecksRow />
            <DesignGalleryRow />
          </ListSection>
        </View>
      ) : null}
    </PlaceholderScreen>
  );
}

/**
 * One tab under a native large title, like the design gallery's. The tab
 * navigator's own header is a fixed 44 points tall, so the screen below
 * would cover its title at the largest text sizes.
 */
function TabRoot({ tab }: { readonly tab: Tab }) {
  return (
    <TabStack.Navigator>
      <TabStack.Screen
        name={`${tab.name}Root`}
        options={{ title: tab.name, headerLargeTitle: true }}
      >
        {() => <TabContent tab={tab} />}
      </TabStack.Screen>
    </TabStack.Navigator>
  );
}

export function TabNavigator() {
  return (
    <Tabs.Navigator
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <WorkoutTabBar {...props} />}
    >
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
          {() => <TabRoot tab={tab} />}
        </Tabs.Screen>
      ))}
    </Tabs.Navigator>
  );
}
