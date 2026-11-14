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

export const savePendingNotification = (pending: PendingNotification) =>
  SecureStore.setItemAsync(
    PENDING_NOTIFICATION_KEY,
    encodePendingNotification(pending),
    SECURE_OPTIONS,
  );

export const forgetPendingNotification = () =>
  SecureStore.deleteItemAsync(PENDING_NOTIFICATION_KEY, SECURE_OPTIONS);

/** Forgets every result and the Keychain value, so each check starts over. */
export async function forgetChecks(): Promise<void> {
  await Promise.all(
    [
      KEYCHAIN_KEY,
      PENDING_NOTIFICATION_KEY,
      ...PHONE_CHECKS.map(({ name }) => outcomeKey(name)),
    ].map((key) => SecureStore.deleteItemAsync(key, SECURE_OPTIONS)),
  );
}
