import { type CoachEvent, decodeCoachEvent } from "@svett/core";
import type { CoachTransport } from "@svett/tools";
import { Effect } from "effect";
import { uuid } from "expo";

import SvettNative from "../../modules/svett-native";

const isEnd = (event: CoachEvent) => event.type === "done" || event.type === "failed";

/**
 * Sends the coach's requests through the Swift module, which adds the ChatGPT token and streams
 * back only events. It waits for the last event, not for the call to return, because the two
 * can reach JavaScript in either order.
 */
export const swiftTransport: CoachTransport = {
  send: (request, onEvent) =>
    Effect.promise(
      () =>
        new Promise<ReadonlyArray<CoachEvent>>((resolve) => {
          const requestId = uuid.v4();
          const events: Array<CoachEvent> = [];
          const finish = () => {
            subscription.remove();
            resolve(events);
          };
          const take = (event: CoachEvent) => {
            events.push(event);
            onEvent(event);
            if (isEnd(event)) finish();
          };
          const subscription = SvettNative.addListener("onCoachEvent", (raw) => {
            if (typeof raw !== "object" || raw === null) return;
            const { requestId: id, ...rest } = raw as { requestId?: unknown };
            if (id !== requestId) return;
            try {
              take(decodeCoachEvent(rest));
            } catch {
              take({ type: "failed", code: "malformed" });
            }
          });
          SvettNative.sendCoachRequest(requestId, JSON.stringify(request)).catch(() => {
            if (!events.some(isEnd)) take({ type: "failed", code: "unreachable" });
          });
        }),
    ),
};
