import {
  type CheckInfo,
  type CheckName,
  type CheckOutcome,
  PHONE_CHECKS,
  formatReport,
  parseCount,
  statusLabel,
} from "@svett/core";
import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import { type ReactNode, useState } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import SvettNative from "../../modules/svett-native";
import {
  useChatGPTCheck,
  useHealthCheck,
  useKeychainCheck,
  useLocationCheck,
  useNotificationCheck,
} from "./hooks";

const STATUS_COLOR: Record<CheckOutcome["status"], string> = {
  "not run": "text-neutral-500 dark:text-neutral-400",
  waiting: "text-amber-600 dark:text-amber-400",
  passed: "text-green-600 dark:text-green-400",
  failed: "text-red-600 dark:text-red-400",
};

function Button({ label, onPress }: { readonly label: string; readonly onPress: () => unknown }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => void onPress()}
      className="rounded-lg bg-rose-600 px-4 py-2 active:opacity-70"
    >
      <Text className="text-base font-semibold text-white">{label}</Text>
    </Pressable>
  );
}

function CheckCard({
  info,
  outcome,
  children,
}: {
  readonly info: CheckInfo;
  readonly outcome: CheckOutcome;
  readonly children?: ReactNode;
}) {
  return (
    <View className="gap-2 rounded-xl bg-neutral-100 p-4 dark:bg-neutral-900">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-lg font-semibold text-black dark:text-white">
          {info.title}
        </Text>
        <Text className={`text-sm font-bold ${STATUS_COLOR[outcome.status]}`}>
          {statusLabel(outcome)}
        </Text>
      </View>
      <Text className="text-sm text-neutral-600 dark:text-neutral-400">{info.steps}</Text>
      {outcome.status === "not run" ? null : (
        <Text selectable className="text-sm text-black dark:text-white">
          {outcome.detail}
        </Text>
      )}
      {children === undefined ? null : <View className="flex-row flex-wrap gap-2">{children}</View>}
    </View>
  );
}

function CountField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
}) {
  return (
    <View className="flex-row items-center justify-between gap-4">
      <Text className="flex-1 text-base text-black dark:text-white">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        keyboardType="number-pad"
        placeholder="0"
        className="w-20 rounded-lg bg-white px-3 py-2 text-right text-base text-black dark:bg-black dark:text-white"
      />
    </View>
  );
}

function SafariPaste({ paste }: { readonly paste: (address: string) => Promise<string | null> }) {
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <View className="w-full gap-2">
      <TextInput
        accessibilityLabel="Address Safari could not open"
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="http://127.0.0.1:…/auth/callback?…"
        className="rounded-lg bg-white px-3 py-2 text-base text-black dark:bg-black dark:text-white"
      />
      {problem === null ? null : <Text className="text-sm text-red-600">{problem}</Text>}
      <Button label="Use address" onPress={async () => setProblem(await paste(address))} />
    </View>
  );
}

export function PhoneChecksScreen() {
  const keychain = useKeychainCheck();
  const notification = useNotificationCheck();
  const location = useLocationCheck();
  const health = useHealthCheck();
  const chatgpt = useChatGPTCheck();
  const [appIds, setAppIds] = useState("");
  const [activeApps, setActiveApps] = useState("");
  const [openedAt] = useState(Date.now);
  const [copiedAt, setCopiedAt] = useState<number>();

  const outcomes: Record<CheckName, CheckOutcome> = {
    keychain,
    notification: notification.outcome,
    location: location.outcome,
    health: health.outcome,
    chatgpt: chatgpt.outcome,
  };
  const actions: Record<CheckName, ReactNode> = {
    keychain: undefined,
    notification: <Button label="Run" onPress={notification.run} />,
    location: <Button label="Run" onPress={location.run} />,
    health: <Button label="Run" onPress={health.run} />,
    chatgpt:
      chatgpt.route === undefined ? (
        <>
          <Button label="Run" onPress={() => chatgpt.run("sheet")} />
          <Button label="Use Safari" onPress={() => chatgpt.run("safari")} />
        </>
      ) : (
        <>
          {chatgpt.route === "safari" ? <SafariPaste paste={chatgpt.paste} /> : null}
          <Button label="Cancel" onPress={chatgpt.cancel} />
        </>
      ),
  };

  const report = (createdAt: number) =>
    formatReport({
      createdAt,
      appVersion: Application.nativeApplicationVersion ?? "unknown",
      appBuild: Application.nativeBuildVersion ?? "unknown",
      iosVersion: String(Platform.Version),
      altStoreAppIds: parseCount(appIds),
      altStoreActiveApps: parseCount(activeApps),
      entitlements: SvettNative.signedEntitlements(),
      outcomes,
    });

  return (
    <ScrollView
      className="flex-1 bg-white dark:bg-black"
      contentContainerClassName="gap-4 p-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-base text-neutral-600 dark:text-neutral-400">
        These checks prove what only a phone can. Run each one, fill in the two numbers from
        AltStore, then copy the report and send it.
      </Text>
      <View className="gap-3 rounded-xl bg-neutral-100 p-4 dark:bg-neutral-900">
        <CountField label="App IDs in use in AltStore" value={appIds} onChange={setAppIds} />
        <CountField label="Active apps in AltStore" value={activeApps} onChange={setActiveApps} />
      </View>
      {PHONE_CHECKS.map((info) => (
        <CheckCard key={info.name} info={info} outcome={outcomes[info.name]}>
          {actions[info.name]}
        </CheckCard>
      ))}
      <View className="flex-row items-center gap-3">
        <Button
          label="Copy report"
          onPress={async () => {
            const now = Date.now();
            await Clipboard.setStringAsync(report(now));
            setCopiedAt(now);
          }}
        />
        {copiedAt === undefined ? null : (
          <Text className="text-sm text-neutral-600 dark:text-neutral-400">
            Copied at {new Date(copiedAt).toLocaleTimeString()}
          </Text>
        )}
      </View>
      <Text selectable className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
        {report(copiedAt ?? openedAt)}
      </Text>
    </ScrollView>
  );
}
