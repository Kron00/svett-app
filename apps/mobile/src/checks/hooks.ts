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
  healthOutcome,
  keychainOutcome,
  locationOutcome,
  notificationDateMs,
  notificationOutcome,
} from "@svett/core";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import SvettNative from "../../modules/svett-native";
import { LOCATION_TASK, awayWindows, locationPoints } from "./background";
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

export function useNotificationCheck() {
  const [observation, setObservation] = useState<NotificationObservation>();
  const scheduled = useRef<PendingNotification>(undefined);
  const away = useStore(awayWindows);

  useEffect(() => {
    const settle = (next: NotificationObservation) => {
      scheduled.current = undefined;
      void forgetPendingNotification();
      setObservation(next);
    };
    const arrived = (notification: Notifications.Notification) => {
      if (notification.request.identifier !== scheduled.current?.id) return;
      settle({ kind: "arrived", at: notificationDateMs(notification.date) });
      void Notifications.dismissNotificationAsync(notification.request.identifier);
    };
    // Finds the notification if it showed while svett was away or closed. Tapping it
    // removes it from the shown ones, so the response that opened svett counts too.
    const look = async () => {
      const pending = scheduled.current;
      if (pending === undefined) return;
      const presented = await Notifications.getPresentedNotificationsAsync();
      const tapped = (await Notifications.getLastNotificationResponseAsync())?.notification;
      const shown = [...presented, ...(tapped === undefined ? [] : [tapped])].find(
        (n) => n.request.identifier === pending.id,
      );
      if (shown !== undefined) {
        arrived(shown);
      } else if (Date.now() > pending.dueAt + 2000 && scheduled.current === pending) {
        settle({ kind: "missing", dueAt: pending.dueAt });
      }
    };
    void loadPendingNotification().then((pending) => {
      if (pending === undefined || scheduled.current !== undefined) return;
      scheduled.current = pending;
      setObservation({ kind: "scheduled", dueAt: pending.dueAt });
      void look();
    });
    const subscriptions = [
      Notifications.addNotificationReceivedListener(arrived),
      Notifications.addNotificationResponseReceivedListener((response) =>
        arrived(response.notification),
      ),
      AppState.addEventListener("change", (state) => {
        if (state === "active") void look();
      }),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  const run = async () => {
    const { granted } = await Notifications.requestPermissionsAsync();
    if (!granted) return setObservation({ kind: "denied" });
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
    observation === undefined
      ? NOT_RUN
      : notificationOutcome(observation, away, SvettNative.launchedAt);
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

export type SignInRoute = "sheet" | "safari";

export function useChatGPTCheck() {
  const [observation, setObservation] = useState<ChatGPTObservation>();
  const [route, setRoute] = useState<SignInRoute>();

  useEffect(() => {
    void SvettNative.chatGPTSession().then((session) => {
      if (session === null) return;
      setObservation(
        (current) => current ?? { kind: "signed in", scope: session.scope, earlier: true },
      );
    });
  }, []);

  const run = async (by: SignInRoute) => {
    const before = observation;
    setRoute(by);
    setObservation({ kind: "signing in" });
    const result = await SvettNative.signInWithChatGPT(by);
    setRoute(undefined);
    switch (result.status) {
      case "signedIn":
        return setObservation({ kind: "signed in", scope: result.session.scope, earlier: false });
      case "failed":
        return setObservation({ kind: "failed", problem: result.problem });
      case "cancelled":
        return setObservation(cancelSignIn(before));
    }
  };

  return {
    outcome: observation === undefined ? NOT_RUN : chatGPTOutcome(observation),
    route,
    run,
    paste: SvettNative.pasteSignInAddress,
    cancel: SvettNative.cancelSignIn,
  };
}
