import {
  type CheckName,
  type PendingNotification,
  PHONE_CHECKS,
  type SeenOutcome,
  type StoredOutcome,
  decodePendingNotification,
  decodeStoredOutcome,
  encodePendingNotification,
  encodeStoredOutcome,
} from "@svett/core";
import * as SecureStore from "expo-secure-store";

import SvettNative from "../../modules/svett-native";

// Results live in the Keychain through expo-secure-store, one item per check, so
// two checks finishing together never overwrite each other's result.
export const SECURE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const KEYCHAIN_KEY = "svett.phoneChecks.keychain";
const PENDING_NOTIFICATION_KEY = "svett.phoneChecks.notification";
const outcomeKey = (name: CheckName) => `svett.phoneChecks.outcome.${name}`;

// A Keychain that refuses fails the Keychain check, so here it reads as nothing saved.
const read = (key: string) => SecureStore.getItemAsync(key, SECURE_OPTIONS).catch(() => null);

export type StoredOutcomes = Partial<Record<CheckName, StoredOutcome>>;

export async function loadOutcomes(): Promise<StoredOutcomes> {
  const entries = await Promise.all(
    PHONE_CHECKS.map(async ({ name }) => [name, decodeStoredOutcome(await read(outcomeKey(name)))]),
  );
  return Object.fromEntries(entries.filter(([, stored]) => stored !== undefined));
}

export const encodeOutcome = (outcome: SeenOutcome): string =>
  encodeStoredOutcome({ outcome, launchedAt: SvettNative.launchedAt });

export const saveOutcome = (name: CheckName, encoded: string) =>
  SecureStore.setItemAsync(outcomeKey(name), encoded, SECURE_OPTIONS);

export const loadPendingNotification = async (): Promise<PendingNotification | undefined> =>
  decodePendingNotification(await read(PENDING_NOTIFICATION_KEY));

// Every write of the pending notification waits for the one before, so a delivery that reads
// the pending notification and saves it back cannot land after a new run has replaced it.
let pendingWrites: Promise<unknown> = Promise.resolve();
const afterPendingWrites = <T>(write: () => Promise<T>): Promise<T> => {
  const next = pendingWrites.then(write, write);
  pendingWrites = next.catch(() => undefined);
  return next;
};

export const savePendingNotification = (pending: PendingNotification) =>
  afterPendingWrites(() =>
    SecureStore.setItemAsync(
      PENDING_NOTIFICATION_KEY,
      encodePendingNotification(pending),
      SECURE_OPTIONS,
    ),
  );

/** Records that notification `id` arrived with svett in front, if it is still the pending one. */
export const markPendingDelivered = (id: string, at: number) =>
  afterPendingWrites(async () => {
    const pending = await loadPendingNotification();
    if (pending?.id !== id) return;
    await SecureStore.setItemAsync(
      PENDING_NOTIFICATION_KEY,
      encodePendingNotification({ ...pending, deliveredInSvett: at }),
      SECURE_OPTIONS,
    );
  });

export const forgetPendingNotification = () =>
  afterPendingWrites(() => SecureStore.deleteItemAsync(PENDING_NOTIFICATION_KEY, SECURE_OPTIONS));

/** Forgets every result and the Keychain value, so each check starts over. */
export async function forgetChecks(): Promise<void> {
  await Promise.all([
    forgetPendingNotification(),
    ...[KEYCHAIN_KEY, ...PHONE_CHECKS.map(({ name }) => outcomeKey(name))].map((key) =>
      SecureStore.deleteItemAsync(key, SECURE_OPTIONS),
    ),
  ]);
}
