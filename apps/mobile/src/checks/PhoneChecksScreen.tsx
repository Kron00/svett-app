import {
  type CheckInfo,
  type CheckName,
  type CheckOutcome,
  PHONE_CHECKS,
  formatReport,
  isSeen,
  mergeOutcomes,
  parseCount,
  resetChecks,
  statusLabel,
} from "@svett/core";
import * as Application from "expo-application";
import * as Clipboard from "expo-clipboard";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { Platform, ScrollView, TextInput, View } from "react-native";

import SvettNative from "../../modules/svett-native";
import { useColor } from "../design/hooks";
import { AppText, type TextTone } from "../ui/AppText";
import { Button } from "../ui/Button";
import { ListSection } from "../ui/List";
import {
  useChatGPTCheck,
  useHealthCheck,
  useKeychainCheck,
  useLocationCheck,
  useNotificationCheck,
} from "./hooks";
import {
  type StoredOutcomes,
  encodeOutcome,
  forgetChecks,
  loadOutcomes,
  saveOutcome,
} from "./saved";

const STATUS_TONE: Record<CheckOutcome["status"], TextTone> = {
  "not run": "secondary",
  waiting: "warning",
  passed: "success",
  failed: "destructive",
  inconclusive: "warning",
};

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
    <View className="mx-gutter gap-2 rounded-card bg-surface p-gutter">
      <View className="flex-row flex-wrap items-center justify-between gap-x-3">
        <AppText variant="headline" accessibilityRole="header" className="shrink">
          {info.title}
        </AppText>
        <AppText variant="subheadline" tone={STATUS_TONE[outcome.status]}>
          {statusLabel(outcome)}
        </AppText>
      </View>
      <AppText variant="subheadline" tone="secondary">
        {info.steps}
      </AppText>
      {isSeen(outcome) ? (
        <AppText variant="subheadline" selectable>
          {outcome.detail}
        </AppText>
      ) : null}
      {children === undefined ? null : (
        <View className="flex-row flex-wrap gap-2 pt-1">{children}</View>
      )}
    </View>
  );
}

function Field({ className, ...props }: ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColor={useColor("secondary-label")}
      className={`min-h-target rounded-field bg-control px-3 py-2 text-body text-label ${className ?? ""}`}
      {...props}
    />
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
    <View className="min-h-target flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 px-gutter py-3">
      <AppText className="shrink">{label}</AppText>
      <Field
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        keyboardType="number-pad"
        placeholder="0"
        className="w-20 text-right"
      />
    </View>
  );
}

function SafariPaste({ paste }: { readonly paste: (address: string) => Promise<string | null> }) {
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <View className="w-full gap-2">
      <Field
        accessibilityLabel="Address Safari could not open"
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="http://127.0.0.1:…/auth/callback?…"
      />
      {problem === null ? null : (
        <AppText variant="subheadline" tone="destructive">
          {problem}
        </AppText>
      )}
      <Button label="Use address" onPress={() => void paste(address).then(setProblem)} />
    </View>
  );
}

/**
 * Keeps each check's latest outcome across launches, and returns what to show: this
 * launch's outcome, otherwise the one an earlier launch saved.
 */
function useSavedOutcomes(live: Record<CheckName, CheckOutcome>): Record<CheckName, CheckOutcome> {
  const [stored, setStored] = useState<StoredOutcomes>({});
  const saved = useRef(new Map<CheckName, string>());
  useEffect(() => {
    void loadOutcomes().then(setStored);
  }, []);

  useEffect(() => {
    for (const { name } of PHONE_CHECKS) {
      const outcome = live[name];
      if (!isSeen(outcome)) continue;
      const value = encodeOutcome(outcome);
      if (saved.current.get(name) === value) continue;
      saved.current.set(name, value);
      void saveOutcome(name, value);
    }
  });

  return mergeOutcomes(live, stored, SvettNative.launchedAt);
}

export function PhoneChecksScreen() {
  // A new key mounts the checks afresh after a reset, and null unmounts them while
  // their saved results are deleted, so none of them saves an old result back.
  const [generation, setGeneration] = useState<number | null>(0);
  const [resetProblem, setResetProblem] = useState<string>();
  const reset = async () => {
    const next = (generation ?? 0) + 1;
    setResetProblem(
      await resetChecks({
        hide: () => setGeneration(null),
        forget: forgetChecks,
        show: () => setGeneration(next),
      }),
    );
  };
  return generation === null ? null : (
    <PhoneChecks key={generation} onReset={reset} resetProblem={resetProblem} />
  );
}

function PhoneChecks({
  onReset,
  resetProblem,
}: {
  readonly onReset: () => Promise<void>;
  readonly resetProblem: string | undefined;
}) {
  const keychain = useKeychainCheck();
  const notification = useNotificationCheck();
  const location = useLocationCheck();
  const health = useHealthCheck();
  const chatgpt = useChatGPTCheck();
  const [appIds, setAppIds] = useState("");
  const [activeApps, setActiveApps] = useState("");
  const [openedAt] = useState(Date.now);
  const [copiedAt, setCopiedAt] = useState<number>();

  const outcomes = useSavedOutcomes({
    keychain,
    notification: notification.outcome,
    location: location.outcome,
    health: health.outcome,
    chatgpt: chatgpt.outcome,
  });
  const actions: Record<CheckName, ReactNode> = {
    keychain: undefined,
    notification: (
      <Button label="Run" testID="check-run-notification" onPress={() => void notification.run()} />
    ),
    location: (
      <Button label="Run" testID="check-run-location" onPress={() => void location.run()} />
    ),
    health: <Button label="Run" testID="check-run-health" onPress={() => void health.run()} />,
    chatgpt:
      chatgpt.route === undefined ? (
        <>
          <Button
            label="Run"
            testID="check-run-chatgpt"
            onPress={() => void chatgpt.run("sheet")}
          />
          <Button
            label="Use Safari"
            variant="secondary"
            onPress={() => void chatgpt.run("safari")}
          />
        </>
      ) : (
        <>
          {chatgpt.route === "safari" ? <SafariPaste paste={chatgpt.paste} /> : null}
          <Button label="Cancel" variant="secondary" onPress={() => void chatgpt.cancel()} />
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
      testID="phone-checks"
      className="flex-1 bg-background"
      contentContainerClassName="gap-4 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <AppText tone="secondary" className="px-gutter">
        These checks prove what only a phone can. Run each one, fill in the two numbers from
        AltStore, then copy the report and send it.
      </AppText>
      <ListSection>
        <CountField label="App IDs in use in AltStore" value={appIds} onChange={setAppIds} />
        <CountField label="Active apps in AltStore" value={activeApps} onChange={setActiveApps} />
      </ListSection>
      {PHONE_CHECKS.map((info) => (
        <CheckCard key={info.name} info={info} outcome={outcomes[info.name]}>
          {actions[info.name]}
        </CheckCard>
      ))}
      <View className="flex-row flex-wrap items-center gap-3 px-gutter">
        <Button
          label="Copy report"
          testID="copy-report"
          onPress={() => {
            const now = Date.now();
            void Clipboard.setStringAsync(report(now)).then(() => setCopiedAt(now));
          }}
        />
        {copiedAt === undefined ? null : (
          <AppText variant="footnote" tone="secondary">
            Copied at {new Date(copiedAt).toLocaleTimeString()}
          </AppText>
        )}
      </View>
      <View className="flex-row px-gutter">
        <Button
          label="Reset checks"
          variant="destructive"
          testID="reset-checks"
          onPress={() => void onReset()}
        />
      </View>
      {resetProblem === undefined ? null : (
        <AppText variant="subheadline" tone="destructive" className="px-gutter">
          {resetProblem}
        </AppText>
      )}
      <AppText variant="caption1" tone="secondary" selectable className="px-gutter font-mono">
        {report(copiedAt ?? openedAt)}
      </AppText>
    </ScrollView>
  );
}
