import { readFileSync } from "node:fs";

import type { CoachEvent, ResponsesRequest } from "@svett/core";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decodeCoachFixture } from "./fixture.ts";
import { bridgeTransport } from "./transport.ts";

const answer = decodeCoachFixture(
  readFileSync(new URL("../fixtures/coach-best-squat.json", import.meta.url), "utf8"),
).exchanges.at(-1)!;
const request = answer.request as ResponsesRequest;

/**
 * A stand-in for the Swift module. It streams the recorded answer one event per tick, tagged with
 * the request's id, until it is cancelled, and then sends Swift's own last event.
 */
const standIn = (options: { readonly refuseSend?: boolean } = {}) => {
  const listeners = new Set<(raw: unknown) => void>();
  const cancelled: Array<string> = [];
  const sent: Array<string> = [];
  let streamed = 0;
  const emit = (raw: unknown) => listeners.forEach((listener) => listener(raw));
  const bridge = {
    listen: (onEvent: (raw: unknown) => void) => {
      listeners.add(onEvent);
      return { remove: () => listeners.delete(onEvent) };
    },
    send: async (requestId: string) => {
      sent.push(requestId);
      if (options.refuseSend === true) throw new Error("no module");
      emit({ requestId: "someone-else", type: "text", delta: "not for this request" });
      const step = async (index: number): Promise<void> => {
        const event = answer.events[index];
        if (event === undefined) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (cancelled.includes(requestId)) {
          emit({ requestId, type: "failed", code: "cancelled" });
          return;
        }
        streamed += 1;
        emit({ requestId, ...event });
        return step(index + 1);
      };
      await step(0);
    },
    cancel: async (requestId: string) => {
      cancelled.push(requestId);
    },
    newRequestId: () => `request-${sent.length + 1}`,
  };
  return { bridge, cancelled, sent, listeners, streamed: () => streamed };
};

describe("the native transport", () => {
  it("passes on each event in order and ends with the last", async () => {
    const swift = standIn();
    const heard: Array<CoachEvent> = [];
    const events = await Effect.runPromise(
      bridgeTransport(swift.bridge).send(request, (event) => heard.push(event)),
    );
    expect(events).toEqual(answer.events);
    expect(heard).toEqual(answer.events);
    expect(swift.listeners.size).toBe(0);
    expect(swift.cancelled).toEqual([]);
  });

  it("cancels the native request when interrupted mid-stream, and hears nothing after", async () => {
    const swift = standIn();
    const heard: Array<CoachEvent> = [];
    const { promise: textArrived, resolve: firstText } = Promise.withResolvers<void>();
    const fiber = Effect.runFork(
      bridgeTransport(swift.bridge).send(request, (event) => {
        heard.push(event);
        if (event.type === "text") firstText();
      }),
    );
    await textArrived;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(swift.cancelled).toEqual(["request-1"]);
    expect(swift.listeners.size).toBe(0);
    const heardAtInterrupt = heard.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heard).toHaveLength(heardAtInterrupt);
    expect(heard.some((event) => event.type === "done" || event.type === "failed")).toBe(false);
    expect(swift.streamed()).toBeLessThan(answer.events.length);
  });

  it("ends with unreachable when the module refuses the request", async () => {
    const swift = standIn({ refuseSend: true });
    const events = await Effect.runPromise(bridgeTransport(swift.bridge).send(request, () => {}));
    expect(events).toEqual([{ type: "failed", code: "unreachable" }]);
    expect(swift.listeners.size).toBe(0);
  });
});
