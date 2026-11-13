import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  Delivery,
  type Destination,
  deliveryCounts,
  deliveryOf,
  dueDeliveries,
  emptyLedger,
  enqueue,
  type Ledger,
  markFailed,
  markSending,
  markSent,
  retryNow,
} from "./delivery.ts";

const MINUTE = 60_000;
const stateOf = (ledger: Ledger, id = "a1") => deliveryOf(ledger, "apple-health", id)?.state;
const send = (ledger: Ledger, now: number, id = "a1") =>
  markSending(ledger, "apple-health", id, now);
const attemptOf = (ledger: Ledger, destination: Destination, id: string): number => {
  const state = deliveryOf(ledger, destination, id)?.state;
  return state?.status === "sending" ? state.attempt : 0;
};
const confirm = (
  ledger: Ledger,
  now: number,
  id = "a1",
  destination: Destination = "apple-health",
) => markSent(ledger, destination, id, attemptOf(ledger, destination, id), now);
const fail = (ledger: Ledger, now: number, id = "a1") => {
  const sending = send(ledger, now, id);
  const attempt = attemptOf(sending, "apple-health", id);
  return markFailed(sending, "apple-health", id, attempt, now, "HealthKit write denied");
};

describe("delivery ledger", () => {
  it("delivers a queued activity once and marks it sent", () => {
    const queued = enqueue(emptyLedger, "apple-health", "a1", 0);
    expect(dueDeliveries(queued, 0).map((d) => d.activityId)).toEqual(["a1"]);

    const sent = confirm(send(queued, 1), 2);
    expect(stateOf(sent)).toEqual({ status: "sent", at: 2 });
    expect(dueDeliveries(sent, 10 * MINUTE)).toEqual([]);
    expect(markSent(sent, "apple-health", "a1", 1, 3)).toBe(sent);
  });

  it("keeps a failure visible with its reason and backs off before the next try", () => {
    const failed = fail(enqueue(emptyLedger, "apple-health", "a1", 0), 0);
    expect(stateOf(failed)).toEqual({
      status: "failed",
      at: 0,
      attempts: 1,
      error: "HealthKit write denied",
      nextAttemptAt: 30_000,
    });
    expect(dueDeliveries(failed, 29_999)).toEqual([]);
    expect(dueDeliveries(failed, 30_000)).toHaveLength(1);

    const twice = fail(failed, 30_000);
    expect(stateOf(twice)).toMatchObject({ attempts: 2, nextAttemptAt: 90_000 });
  });

  it("caps the back-off at an hour and never drops a failed delivery", () => {
    let ledger = enqueue(emptyLedger, "apple-health", "a1", 0);
    for (let attempt = 1; attempt <= 20; attempt++) ledger = fail(ledger, attempt * 100 * MINUTE);
    expect(stateOf(ledger)).toMatchObject({
      status: "failed",
      attempts: 20,
      nextAttemptAt: 2000 * MINUTE + 60 * MINUTE,
    });
  });

  it("lets the user retry an old failure at once", () => {
    const failed = fail(enqueue(emptyLedger, "apple-health", "old", 0), 0, "old");
    const retried = retryNow(failed, "apple-health", "old", 1);
    expect(stateOf(retried, "old")).toEqual({ status: "pending", since: 1 });
    expect(dueDeliveries(retried, 1)).toHaveLength(1);
  });

  it("backfills an activity that was never queued", () => {
    const ledger = enqueue(emptyLedger, "apple-health", "from-last-year", 5);
    expect(dueDeliveries(ledger, 5).map((d) => d.activityId)).toEqual(["from-last-year"]);
  });

  it("sends an edit made during a send again instead of losing it", () => {
    const sending = markSending(enqueue(emptyLedger, "server", "a1", 0), "server", "a1", 1);
    const edited = enqueue(sending, "server", "a1", 2);
    const confirmed = confirm(edited, 3, "a1", "server");
    expect(deliveryOf(confirmed, "server", "a1")?.state).toEqual({ status: "pending", since: 3 });
  });

  it("retries a send that a crash left unconfirmed", () => {
    const sending = send(enqueue(emptyLedger, "apple-health", "a1", 0), 0);
    expect(dueDeliveries(sending, MINUTE)).toEqual([]);
    expect(dueDeliveries(sending, 2 * MINUTE)).toHaveLength(1);
    expect(stateOf(send(sending, 2 * MINUTE))).toMatchObject({ status: "sending", attempt: 2 });
  });

  it("ignores a late reply from a send that was abandoned as stale", () => {
    const first = send(enqueue(emptyLedger, "apple-health", "a1", 0), 0);
    const second = send(first, 2 * MINUTE);
    expect(markSent(second, "apple-health", "a1", 1, 3 * MINUTE)).toBe(second);
    expect(markFailed(second, "apple-health", "a1", 1, 3 * MINUTE, "timeout")).toBe(second);
    expect(stateOf(markSent(second, "apple-health", "a1", 2, 3 * MINUTE))).toEqual({
      status: "sent",
      at: 3 * MINUTE,
    });
  });

  it("re-sends an activity edited after it was sent", () => {
    const sent = confirm(send(enqueue(emptyLedger, "apple-health", "a1", 0), 0), 1);
    expect(stateOf(enqueue(sent, "apple-health", "a1", 9))).toEqual({
      status: "pending",
      since: 9,
    });
  });

  it("tracks each destination separately", () => {
    const ledger = confirm(
      send(enqueue(enqueue(emptyLedger, "server", "a1", 0), "apple-health", "a1", 0), 0),
      1,
    );
    expect(deliveryOf(ledger, "server", "a1")?.state.status).toBe("pending");
    expect(deliveryOf(ledger, "apple-health", "a1")?.state.status).toBe("sent");
  });

  it("counts the status of the last workouts for a status screen", () => {
    let ledger = enqueue(emptyLedger, "apple-health", "sent", 0);
    ledger = confirm(send(ledger, 0, "sent"), 1, "sent");
    ledger = fail(enqueue(ledger, "apple-health", "failed", 0), 0, "failed");
    ledger = enqueue(ledger, "apple-health", "pending", 0);
    expect(
      deliveryCounts(ledger, "apple-health", ["sent", "failed", "pending", "never-queued"]),
    ).toEqual({ pending: 1, sending: 0, sent: 1, failed: 1, never: 1 });
  });

  it("parses a stored delivery and rejects a malformed one", () => {
    const decode = Schema.decodeUnknownSync(Delivery);
    const stored = {
      destination: "apple-health",
      activityId: "a1",
      state: { status: "failed", at: 0, attempts: 1, error: "denied", nextAttemptAt: 30_000 },
    };
    expect(decode(stored)).toEqual(stored);
    expect(() => decode({ ...stored, state: { status: "failed", at: 0 } })).toThrow();
    expect(() => decode({ ...stored, destination: "strava" })).toThrow();
  });
});
