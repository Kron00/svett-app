import { describe, expect, it } from "vite-plus/test";

import { MANAGE_USAGE_URL } from "./chatgpt.ts";
import {
  checkResponsesRequest,
  coachFailure,
  coachInstructions,
  dayStart,
  decodeCoachEvent,
  type InputItem,
  instructionsOffset,
  localDay,
  PLAN_LIMIT_CODE,
  type ResponsesRequest,
  trimChat,
} from "./coach.ts";

const user = (text: string): InputItem => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const assistant = (text: string): InputItem => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

const valid: ResponsesRequest = {
  model: "gpt-6.1-sol",
  instructions: "Coach",
  input: [
    user("Best squat?"),
    {
      type: "function_call",
      call_id: "c1",
      name: "best_sets",
      namespace: "svett",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "c1", output: "{}" },
  ],
  tools: [
    {
      type: "namespace",
      name: "svett",
      description: "Read",
      tools: [{ type: "function", name: "best_sets", description: "Best", parameters: {} }],
    },
  ],
  stream: true,
  store: false,
};

describe("checkResponsesRequest", () => {
  it("passes a request that keeps every plan usage rule", () => {
    expect(checkResponsesRequest(valid)).toEqual([]);
  });

  it("names each rule a request breaks", () => {
    expect(
      checkResponsesRequest({
        ...valid,
        stream: false,
        store: true,
        instructions: "",
        previous_response_id: "resp_1",
        temperature: 0.2,
        max_output_tokens: 500,
        input: [
          { type: "message", role: "system", content: "You are a coach" },
          { type: "function_call", call_id: "c2", name: "best_sets", arguments: "{}" },
        ],
        tools: [{ type: "function", name: "best_sets" }, { type: "web_search" }],
      }),
    ).toEqual([
      "stream must be true",
      "store must be false",
      "instructions must hold the coach's instructions",
      "previous_response_id is not allowed",
      "temperature is not allowed",
      "max_output_tokens is not allowed",
      "function call c2 has no output after it",
      "a system message is not allowed",
      "function tools must be grouped in a namespace",
      "function tools must be grouped in a namespace",
    ]);
  });

  it("refuses a hosted tool inside a namespace and an empty chat", () => {
    expect(
      checkResponsesRequest({
        ...valid,
        input: [],
        tools: [{ type: "namespace", name: "svett", tools: [{ type: "file_search" }] }],
      }),
    ).toEqual(["input must list the whole chat", "namespace svett may hold only function tools"]);
  });

  it("refuses an output that comes before its call", () => {
    expect(
      checkResponsesRequest({
        ...valid,
        input: [
          user("Hi"),
          { type: "function_call_output", call_id: "c1", output: "{}" },
          { type: "function_call", call_id: "c1", name: "best_sets", arguments: "{}" },
        ],
      }),
    ).toEqual(["function call c1 has no output after it"]);
  });
});

describe("coachFailure", () => {
  it("words the plan's limit and links to ChatGPT's usage settings", () => {
    expect(coachFailure(PLAN_LIMIT_CODE)).toMatchObject({
      kind: "planLimit",
      text: expect.stringContaining("plan's limit"),
      link: { url: MANAGE_USAGE_URL },
    });
  });

  it("names the plans that allow plan usage when the account is not eligible", () => {
    expect(coachFailure("subscription_sharing_user_not_eligible")).toMatchObject({
      kind: "planUsageOff",
      text: expect.stringContaining("Go, Plus, Pro and Business"),
    });
    expect(coachFailure("planUsageOff").kind).toBe("planUsageOff");
  });

  it("sends an ended sign-in back to Continue with ChatGPT", () => {
    for (const code of [
      "lapsed",
      "clientRefused",
      "subscription_sharing_invalid_user",
      "http401",
    ]) {
      expect(coachFailure(code).kind).toBe("signIn");
    }
  });

  it("tells an unsupported capability apart from an unknown code", () => {
    expect(coachFailure("subscription_sharing_unsupported_capability").kind).toBe("unsupported");
    expect(coachFailure("server_error")).toEqual({
      kind: "other",
      text: "ChatGPT did not answer (server_error). Try again.",
    });
  });
});

describe("days", () => {
  it("turns a day into the time its midnight falls at an offset from UTC", () => {
    expect(dayStart("2026-10-01", 0)).toBe(Date.UTC(2026, 9, 1));
    expect(dayStart("2026-10-01", -420)).toBe(Date.UTC(2026, 9, 1, 7));
    expect(dayStart("2026-10-01", 120)).toBe(Date.UTC(2026, 8, 30, 22));
  });

  it("refuses a day that does not exist", () => {
    expect(dayStart("2026-02-30", 0)).toBeNull();
    expect(dayStart("2026-1-3", 0)).toBeNull();
    expect(dayStart("yesterday", 0)).toBeNull();
  });

  it("names the day a time falls on at an offset", () => {
    expect(localDay(Date.UTC(2026, 9, 1, 3), 0)).toBe("2026-10-01");
    expect(localDay(Date.UTC(2026, 9, 1, 3), -420)).toBe("2026-09-30");
  });
});

describe("coachInstructions", () => {
  it("names today and the time zone, which a replay reads back", () => {
    const now = Date.UTC(2026, 10, 13, 17);
    const text = coachInstructions(now, -420);
    expect(text).toContain("Today is 2026-11-13.");
    expect(instructionsOffset(text)).toBe(-420);
    expect(instructionsOffset(coachInstructions(now, 330))).toBe(330);
    expect(instructionsOffset("no zone")).toBeNull();
  });
});

const size = (items: ReadonlyArray<InputItem>) =>
  items.reduce((total, item) => total + JSON.stringify(item).length, 0);

describe("trimChat", () => {
  const turn = (n: number): ReadonlyArray<InputItem> => [
    user(`question ${n} ${"x".repeat(100)}`),
    { type: "function_call", call_id: `c${n}`, name: "list_routines", arguments: "{}" },
    { type: "function_call_output", call_id: `c${n}`, output: "y".repeat(100) },
    assistant(`answer ${n}`),
  ];
  const chat = [...turn(1), ...turn(2), ...turn(3), user("question 4")];

  it("keeps a chat that fits whole", () => {
    expect(trimChat(chat, 100_000)).toEqual(chat);
  });

  it("drops the oldest whole turns, so every call keeps its output", () => {
    const kept = trimChat(chat, size([...turn(3), user("question 4")]) + 10);
    expect(kept).toEqual([...turn(3), user("question 4")]);
    expect(checkResponsesRequest({ ...valid, input: kept })).toEqual([]);
  });

  it("always keeps the question being asked", () => {
    expect(trimChat(chat, 1)).toEqual([user("question 4")]);
  });
});

describe("decodeCoachEvent", () => {
  it("reads the events Swift sends and refuses anything else", () => {
    expect(decodeCoachEvent({ type: "text", delta: "Hi" })).toEqual({ type: "text", delta: "Hi" });
    expect(decodeCoachEvent({ type: "failed", code: PLAN_LIMIT_CODE, status: 429 })).toEqual({
      type: "failed",
      code: PLAN_LIMIT_CODE,
      status: 429,
    });
    expect(() => decodeCoachEvent({ type: "token", value: "secret" })).toThrow();
  });
});
