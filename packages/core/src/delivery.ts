import { Schema } from "effect";

export const Destination = Schema.Literals(["server", "apple-health"]);
export type Destination = typeof Destination.Type;

const EpochMs = Schema.Number.check(Schema.isFinite());
const Attempt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

export const DeliveryState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), since: EpochMs }),
  Schema.Struct({
    status: Schema.Literal("sending"),
    since: EpochMs,
    sendId: Schema.String,
    attempt: Attempt,
    resend: Schema.Boolean,
  }),
  Schema.Struct({ status: Schema.Literal("sent"), at: EpochMs }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    at: EpochMs,
    attempts: Attempt,
    error: Schema.String,
    nextAttemptAt: EpochMs,
  }),
]);
export type DeliveryState = typeof DeliveryState.Type;

export const Delivery = Schema.Struct({
  destination: Destination,
  activityId: Schema.String,
  state: DeliveryState,
});
export type Delivery = typeof Delivery.Type;

export type Ledger = ReadonlyMap<string, Delivery>;

export const emptyLedger: Ledger = new Map();

const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 60 * 60_000;
const STALE_SEND_MS = 2 * 60_000;

export const retryDelayMs = (attempts: number): number =>
  Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);

const keyOf = (destination: Destination, activityId: string): string =>
  `${destination}\u0000${activityId}`;

export const deliveryOf = (
  ledger: Ledger,
  destination: Destination,
  activityId: string,
): Delivery | undefined => ledger.get(keyOf(destination, activityId));

const update = (
  ledger: Ledger,
  destination: Destination,
  activityId: string,
  next: (state: DeliveryState | undefined) => DeliveryState | undefined,
): Ledger => {
  const key = keyOf(destination, activityId);
  const current = ledger.get(key)?.state;
  const state = next(current);
  if (state === undefined || state === current) return ledger;
  return new Map(ledger).set(key, { destination, activityId, state });
};

/** Queue an activity for a destination, after it was logged or edited, or to backfill one never sent. */
export const enqueue = (
  ledger: Ledger,
  destination: Destination,
  activityId: string,
  now: number,
): Ledger =>
  update(ledger, destination, activityId, (state) => {
    switch (state?.status) {
      case "pending":
        return state;
      case "sending":
        return state.resend ? state : { ...state, resend: true };
      default:
        return { status: "pending", since: now };
    }
  });

/** `sendId` is a fresh random ID per send, so a late reply from an abandoned send is ignored. */
export const markSending = (
  ledger: Ledger,
  destination: Destination,
  activityId: string,
  sendId: string,
  now: number,
): Ledger =>
  update(ledger, destination, activityId, (state) => {
    switch (state?.status) {
      case "pending":
        return { status: "sending", since: now, sendId, attempt: 1, resend: false };
      case "failed":
        return {
          status: "sending",
          since: now,
          sendId,
          attempt: state.attempts + 1,
          resend: false,
        };
      case "sending":
        return state.since + STALE_SEND_MS <= now
          ? { status: "sending", since: now, sendId, attempt: state.attempt + 1, resend: false }
          : state;
      default:
        return state;
    }
  });

export const markSent = (
  ledger: Ledger,
  destination: Destination,
  activityId: string,
  sendId: string,
  now: number,
): Ledger =>
  update(ledger, destination, activityId, (state) =>
    state?.status !== "sending" || state.sendId !== sendId
      ? state
      : state.resend
        ? { status: "pending", since: now }
        : { status: "sent", at: now },
  );

export const markFailed = (
  ledger: Ledger,
  destination: Destination,
  activityId: string,
  sendId: string,
  now: number,
  error: string,
): Ledger =>
  update(ledger, destination, activityId, (state) =>
    state?.status !== "sending" || state.sendId !== sendId
      ? state
      : {
          status: "failed",
          at: now,
          attempts: state.attempt,
          error,
          nextAttemptAt: now + retryDelayMs(state.attempt),
        },
  );

/** The user's Retry button. Works on any failed delivery, however old. */
export const retryNow = (
  ledger: Ledger,
  destination: Destination,
  activityId: string,
  now: number,
): Ledger =>
  update(ledger, destination, activityId, (state) =>
    state?.status === "failed" ? { status: "pending", since: now } : state,
  );

/** Deliveries a sender should attempt now, including sends a crash left unconfirmed. */
export const dueDeliveries = (ledger: Ledger, now: number): ReadonlyArray<Delivery> =>
  [...ledger.values()].filter(({ state }) => {
    switch (state.status) {
      case "pending":
        return true;
      case "failed":
        return state.nextAttemptAt <= now;
      case "sending":
        return state.since + STALE_SEND_MS <= now;
      case "sent":
        return false;
    }
  });

export type DeliveryCounts = Readonly<Record<DeliveryState["status"], number>>;

/** What a sync status screen shows for the given activities, such as the last five. */
export const deliveryCounts = (
  ledger: Ledger,
  destination: Destination,
  activityIds: Iterable<string>,
): DeliveryCounts & { readonly never: number } => {
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, never: 0 };
  for (const activityId of activityIds) {
    const delivery = deliveryOf(ledger, destination, activityId);
    counts[delivery?.state.status ?? "never"] += 1;
  }
  return counts;
};
