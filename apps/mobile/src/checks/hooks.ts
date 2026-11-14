import {
  type ChatGPTObservation,
  type CheckOutcome,
  type HealthObservation,
  type KeychainRead,
  type LocationObservation,
  type NotificationObservation,
  NOT_RUN,
  type PendingNotification,
  cancelSignIn,
  chatGPTOutcome,
  encodeKeychainMark,
  findNotification,
  healthOutcome,
  keychainOutcome,
  locationOutcome,
  notificationDateMs,
  notificationOutcome,
  signInProblemMessage,
} from "@svett/core";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef, useState } from "react";

import SvettNative from "../../modules/svett-native";
import {
  type SignInRoute,
  cancelSignIn as cancelNativeSignIn,
  chatGPTStatus,
  pasteSignInAddress,
  signInWithChatGPT,
} from "../chatgpt/native";
import { LOCATION_TASK, awayWindows, locationPoints, notificationsInSvett } from "./background";
import {
  KEYCHAIN_KEY,
  SECURE_OPTIONS,
  forgetPendingNotification,
  loadPendingNotification,
  savePendingNotification,
} from "./saved";
import { useStore } from "./store";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The value is written only when none is stored, so every later launch, and a reload of
// this one, reads what the first launch saved instead of what it just wrote itself.
const readKeychain = async (): Promise<KeychainRead> => {
  try {
    const stored = await SecureStore.getItemAsync(KEYCHAIN_KEY, SECURE_OPTIONS);
    if (stored === null) {
      await SecureStore.setItemAsync(
        KEYCHAIN_KEY,
        encodeKeychainMark(SvettNative.launchedAt),
        SECURE_OPTIONS,
      );
    }
    return { kind: "read", stored };
  } catch (error) {
    return { kind: "error", message: message(error) };
  }
};

export function useKeychainCheck(): CheckOutcome {
  const [read, setRead] = useState<KeychainRead>();
  useEffect(() => {
    void readKeychain().then(setRead);
  }, []);
  return read === undefined ? NOT_RUN : keychainOutcome(read, SvettNative.launchedAt);
}

const NOTIFICATION_DELAY_S = 10;

/** When iOS showed the notification while svett was away, if it is still shown or was tapped. */
const shownAt = async (id: string): Promise<number | undefined> => {
  const presented = await Notifications.getPresentedNotificationsAsync();
  const tapped = Notifications.getLastNotificationResponse()?.notification;
  const shown = [...presented, ...(tapped === undefined ? [] : [tapped])].find(
    (n) => n.request.identifier === id,
  );
  return shown === undefined ? undefined : notificationDateMs(shown.date);
};

export function useNotificationCheck() {
  const [observation, setObservation] = useState<NotificationObservation>();
  const scheduled = useRef<PendingNotification>(undefined);

  useEffect(() => {
    const look = async () => {
      const pending = scheduled.current;
      if (pending === undefined) return;
      const shown = await shownAt(pending.id);
      const inSvett = notificationsInSvett.get().get(pending.id);
      const next = findNotification(pending, { inSvett, shown }, Date.now());
      if (next.kind === "scheduled" || scheduled.current !== pending) return;
      scheduled.current = undefined;
      void forgetPendingNotification();
      void Notifications.dismissNotificationAsync(pending.id);
      setObservation(next);
    };
    void loadPendingNotification().then((pending) => {
      if (pending === undefined || scheduled.current !== undefined) return;
      scheduled.current = pending;
      setObservation({ kind: "scheduled", dueAt: pending.dueAt });
      void look();
    });
    // Polls instead of waiting for AppState, because in a Release run on the simulator the
    // check had not found the notification after svett came back to the front.
    const timer = setInterval(() => void look(), 1000);
    const unsubscribe = notificationsInSvett.subscribe(() => void look());
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const run = async () => {
    const { granted } = await Notifications.requestPermissionsAsync();
    if (!granted) return setObservation({ kind: "denied" });
    // Otherwise the earlier run's notification can show while svett is away and be
    // taken for this one, which then arrives with svett back in front.
    const earlier = scheduled.current;
    scheduled.current = undefined;
    if (earlier !== undefined) {
      await Notifications.cancelScheduledNotificationAsync(earlier.id);
      await Notifications.dismissNotificationAsync(earlier.id);
    }
    const dueAt = Date.now() + NOTIFICATION_DELAY_S * 1000;
    const id = await Notifications.scheduleNotificationAsync({
      content: { title: "svett", body: "The background notification check worked." },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: NOTIFICATION_DELAY_S,
      },
    });
    scheduled.current = { id, dueAt };
    void savePendingNotification({ id, dueAt });
    setObservation({ kind: "scheduled", dueAt });
  };

  const outcome =
    observation === undefined ? NOT_RUN : notificationOutcome(observation, SvettNative.launchedAt);
  return { outcome, run };
}

type LocationRun =
  | { readonly kind: "denied" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "recording";
      readonly startedAt: number;
      readonly access: "always" | "while using";
    };

const stopLocation = async () => {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
};

export function useLocationCheck() {
  const [run, setRun] = useState<LocationRun>();
  const points = useStore(locationPoints);
  const away = useStore(awayWindows);
  const observation: LocationObservation | undefined =
    run?.kind === "recording" ? { ...run, points } : run;
  const outcome = observation === undefined ? NOT_RUN : locationOutcome(observation, away);
  const finished = outcome.status === "passed" || outcome.status === "failed";

  useEffect(() => {
    if (finished) void stopLocation();
  }, [finished]);
  useEffect(
    () => () => {
      void stopLocation();
    },
    [],
  );

  const start = async () => {
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) return setRun({ kind: "denied" });
    const background = await Location.requestBackgroundPermissionsAsync();
    await stopLocation();
    locationPoints.set([]);
    try {
      await Location.startLocationUpdatesAsync(LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 0,
        activityType: Location.ActivityType.Fitness,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
      });
    } catch (error) {
      return setRun({ kind: "error", message: message(error) });
    }
    setRun({
      kind: "recording",
      startedAt: Date.now(),
      access: background.granted ? "always" : "while using",
    });
  };

  return { outcome, run: start };
}

export function useHealthCheck() {
  const [health, setHealth] = useState<HealthObservation>();
  const run = async () => {
    const access = await SvettNative.requestWorkoutAccess();
    const entitlements = SvettNative.signedEntitlements();
    setHealth({
      entitlement:
        entitlements === null ? null : entitlements.includes("com.apple.developer.healthkit"),
      access,
    });
  };
  return { outcome: health === undefined ? NOT_RUN : healthOutcome(health), run };
}

export function useChatGPTCheck() {
  const [observation, setObservation] = useState<ChatGPTObservation>();
  const [route, setRoute] = useState<SignInRoute>();

  useEffect(() => {
    void chatGPTStatus().then((status) => {
      if (status.state !== "signedIn") return;
      setObservation(
        (current) => current ?? { kind: "signed in", scope: status.scope, earlier: true },
      );
    });
  }, []);

  const run = async (by: SignInRoute) => {
    const before = observation;
    setRoute(by);
    setObservation({ kind: "signing in" });
    const result = await signInWithChatGPT(by, "returning");
    setRoute(undefined);
    switch (result.status) {
      case "signedIn":
        return setObservation(
          result.account.state === "signedIn"
            ? { kind: "signed in", scope: result.account.scope, earlier: false }
            : { kind: "failed", problem: signInProblemMessage("refused") },
        );
      case "failed":
        return setObservation({ kind: "failed", problem: signInProblemMessage(result.problem) });
      case "cancelled":
        return setObservation(cancelSignIn(before));
    }
  };

  return {
    outcome: observation === undefined ? NOT_RUN : chatGPTOutcome(observation),
    route,
    run,
    paste: pasteSignInAddress,
    cancel: cancelNativeSignIn,
  };
}
