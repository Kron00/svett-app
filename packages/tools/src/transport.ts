import { type CoachEvent, decodeCoachEvent } from "@svett/core";
import { Effect } from "effect";

import type { CoachTransport } from "./coach.ts";

/** The native module that sends the coach's requests. Its events carry the request's id. */
export interface CoachBridge {
  readonly listen: (onEvent: (raw: unknown) => void) => { readonly remove: () => void };
  readonly send: (requestId: string, body: string) => Promise<void>;
  /** Stops a request that is still streaming. A request that already ended is left alone. */
  readonly cancel: (requestId: string) => Promise<void>;
  readonly newRequestId: () => string;
}

const isEnd = (event: CoachEvent) => event.type === "done" || event.type === "failed";

/**
 * Sends each request through the bridge and waits for its last event, not for `send` to return,
 * because the two can arrive in either order. Interrupting the effect cancels the native request,
 * and nothing it sends afterwards reaches `onEvent`.
 */
export const bridgeTransport = (bridge: CoachBridge): CoachTransport => ({
  send: (request, onEvent) =>
    Effect.callback<ReadonlyArray<CoachEvent>>((resume) => {
      const requestId = bridge.newRequestId();
      const events: Array<CoachEvent> = [];
      let settled = false;
      const settle = () => {
        settled = true;
        subscription.remove();
      };
      const take = (event: CoachEvent) => {
        if (settled) return;
        events.push(event);
        onEvent(event);
        if (isEnd(event)) {
          settle();
          resume(Effect.succeed(events));
        }
      };
      const subscription = bridge.listen((raw) => {
        if (typeof raw !== "object" || raw === null) return;
        const { requestId: id, ...rest } = raw as { requestId?: unknown };
        if (id !== requestId) return;
        try {
          take(decodeCoachEvent(rest));
        } catch {
          take({ type: "failed", code: "malformed" });
        }
      });
      bridge.send(requestId, JSON.stringify(request)).catch(() => {
        take({ type: "failed", code: "unreachable" });
      });
      return Effect.sync(() => {
        if (settled) return;
        settle();
        bridge.cancel(requestId).catch(() => undefined);
      });
    }),
});
