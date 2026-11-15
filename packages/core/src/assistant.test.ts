import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  accessLabel,
  type AssistantProposalList,
  assistantProposalId,
  base64url,
  clientLabel,
  connectedLine,
  connectionAccess,
  lastReadLine,
  pkceChallenge,
  pkceMatches,
  receiveAssistantProposals,
  requestedScopes,
  waitingAssistantProposals,
} from "./assistant.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import { applyProposal, type ProposalPlan, proposalView } from "./proposals.ts";
import { ProposalRepository } from "./repositories/records.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import { openTestDatabase } from "./test-database.ts";

const BENCH = libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip");

const plan: ProposalPlan = {
  kind: "routine",
  routine: {
    title: "Push day",
    notes: "",
    exercises: [
      {
        exerciseId: BENCH,
        restS: null,
        notes: "",
        sets: [
          {
            setType: "normal",
            weightKg: 80,
            repsMin: 6,
            repsMax: 8,
            durationS: null,
            distanceM: null,
          },
        ],
      },
    ],
  },
};

/** A stand-in server holding `list`, which records each batch of IDs the phone says it took. */
const server = (list: AssistantProposalList) => {
  const received: Array<ReadonlyArray<string>> = [];
  return {
    received,
    source: {
      waiting: Effect.succeed(list),
      received: (ids: ReadonlyArray<string>) => Effect.sync(() => received.push(ids)),
    },
  };
};

describe("PKCE", () => {
  it("matches RFC 7636's own example of an S256 challenge", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(pkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(pkceMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
  });

  it("refuses another verifier, and one too short or with characters the RFC forbids", () => {
    const challenge = pkceChallenge("a".repeat(43));
    expect(pkceMatches("b".repeat(43), challenge)).toBe(false);
    expect(pkceMatches("a".repeat(42), pkceChallenge("a".repeat(42)))).toBe(false);
    expect(pkceMatches(`${"a".repeat(42)}!`, pkceChallenge(`${"a".repeat(42)}!`))).toBe(false);
  });

  it("writes base64url without padding, as Node does", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 32]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 97 + 251) % 256);
      expect(base64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });
});

describe("scopes", () => {
  it("offers what a request names, in svett's order, and both when it names none svett knows", () => {
    expect(requestedScopes("svett.propose svett.read")).toEqual(["svett.read", "svett.propose"]);
    expect(requestedScopes("svett.read")).toEqual(["svett.read"]);
    expect(requestedScopes("openid email")).toEqual(["svett.read", "svett.propose"]);
    expect(requestedScopes(undefined)).toEqual(["svett.read", "svett.propose"]);
  });

  it("says what a connection may do in one line", () => {
    expect(connectionAccess(["svett.read"])).toBe("Read your training");
    expect(connectionAccess(["svett.propose"])).toBe("Propose routines and programs");
    expect(connectionAccess(["svett.propose", "svett.read"])).toBe(
      "Read your training and propose routines and programs",
    );
  });

  it("says when a connection last read, or that it has not yet", () => {
    expect(lastReadLine(null, () => "never")).toBe("Has not read your data yet");
    expect(lastReadLine(5, (at) => `day ${at}`)).toBe("Last read your data on day 5");
    expect(connectedLine(7, (at) => `day ${at}`)).toBe("Connected on day 7");
  });

  it("says in words what each tool call in the access log did", () => {
    expect(accessLabel("list_workouts")).toBe("Listed workouts");
    expect(accessLabel("propose_routine")).toBe("Proposed a routine");
    expect(accessLabel("get_workout")).toBe("Read a workout");
    expect(accessLabel("new_tool_name")).toBe("New tool name");
    expect(accessLabel("__")).toBe("Used a tool");
  });

  it("cuts a long client name and names a client that gave none", () => {
    expect(clientLabel("  ChatGPT  ")).toBe("ChatGPT");
    expect(clientLabel(undefined)).toBe("An assistant");
    expect(clientLabel("x".repeat(80))).toHaveLength(60);
  });
});

describe("receiveAssistantProposals", () => {
  it("stores each waiting proposal once as pending, and only Apply makes the routine", async () => {
    const database = openTestDatabase();
    const { source, received } = server({
      proposals: [{ id: "server-1", from: "ChatGPT", plan, createdAt: 1_000 }],
    });
    const stored = await database.runtime.runPromise(receiveAssistantProposals(source));
    expect(stored).toBe(1);
    expect(received).toEqual([["server-1"]]);
    const id = assistantProposalId("server-1");
    const view = await database.runtime.runPromise(proposalView(id));
    expect(view.status).toBe("pending");
    expect(view.plan).toEqual(plan);
    const proposals = await database.runtime.runPromise(
      Effect.flatMap(Effect.service(ProposalRepository), (repository) => repository.list),
    );
    expect(proposals.map((each) => [each.origin, each.coachMessageId, each.createdAt])).toEqual([
      ["assistant", null, 1_000],
    ]);
    expect(waitingAssistantProposals(proposals)).toEqual([id]);
    const routines = () =>
      database.runtime.runPromise(
        Effect.flatMap(Effect.service(RoutineRepository), (repository) => repository.listRoutines),
      );
    expect(await routines()).toEqual([]);
    await database.runtime.runPromise(applyProposal(id));
    expect((await routines()).map((routine) => routine.title)).toEqual(["Push day"]);
  });

  it("stores nothing again when the server sends a proposal the phone took, even removed", async () => {
    const database = openTestDatabase();
    const list = { proposals: [{ id: "server-2", from: "ChatGPT", plan, createdAt: 2_000 }] };
    await database.runtime.runPromise(receiveAssistantProposals(server(list).source));
    await database.runtime.runPromise(
      Effect.flatMap(Effect.service(ProposalRepository), (repository) =>
        repository.remove(assistantProposalId("server-2")),
      ),
    );
    const again = server(list);
    expect(await database.runtime.runPromise(receiveAssistantProposals(again.source))).toBe(0);
    expect(again.received).toEqual([["server-2"]]);
    const proposals = await database.runtime.runPromise(
      Effect.flatMap(Effect.service(ProposalRepository), (repository) => repository.list),
    );
    expect(proposals).toEqual([]);
  });

  it("asks nothing more of the server when no proposal waits", async () => {
    const database = openTestDatabase();
    const empty = server({ proposals: [] });
    expect(await database.runtime.runPromise(receiveAssistantProposals(empty.source))).toBe(0);
    expect(empty.received).toEqual([]);
  });
});
