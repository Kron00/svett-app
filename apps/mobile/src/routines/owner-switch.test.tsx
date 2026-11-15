import {
  AccountId,
  type ActivityRepository,
  ANONYMOUS,
  databaseLayer,
  decodeSvettFile,
  type ExerciseRepository,
  Ids,
  libraryExerciseId,
  loadWorkoutLog,
  RoutineRepository,
  type RoutineId,
  TransferRepository,
} from "@svett/core";
import { openNodeDatabase } from "@svett/core/node";
import { Effect, ManagedRuntime, Option, Result } from "effect";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { switchOwner } from "../data/current";
import { SWITCHED_BEFORE_WRITE } from "../data/store";
import { RoutineDetailScreen } from "./RoutineDetailScreen";

type Runtime = ManagedRuntime.ManagedRuntime<
  ActivityRepository | ExerciseRepository | RoutineRepository | TransferRepository,
  unknown
>;

type Button = { readonly text: string; readonly onPress?: () => void };

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  route: { params: { id: "" } },
  alerts: [] as Array<{ title: string; message?: string; buttons?: ReadonlyArray<Button> }>,
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, message?: string, buttons?: ReadonlyArray<Button>) =>
      app.alerts.push({ title, message, buttons }),
  },
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Settings: { get: () => undefined, set: () => {} },
  StyleSheet: { hairlineWidth: 0.5 },
  Switch: "Switch",
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: () => {}, removeItemSync: () => {} },
}));
vi.mock("../account/config", () => ({ CLERK_PUBLISHABLE_KEY: "pk_test_svett" }));
vi.mock("../data/launch-timing", () => ({ markLaunch: () => {} }));
// Each owner's file is an in-memory SQLite database that outlives its handles, as a file would.
vi.mock("../data/database", () => ({
  launchFixture: () => undefined,
  openDatabaseHandle: (target: { kind: string; owner?: { kind: string; accountId?: string } }) => ({
    target,
    get runtime() {
      return app.databases.get(target.owner?.accountId ?? target.owner?.kind ?? target.kind);
    },
    close: async () => {},
  }),
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  const navigation = {
    isFocused: () => true,
    goBack: () => {},
    navigate: () => {},
    push: () => {},
  };
  return {
    DarkTheme: { colors: {} },
    useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]),
    useNavigation: () => navigation,
    useRoute: () => app.route,
  };
});

const ACCOUNT = AccountId.make("user_svett_routines");

const openDatabase = (seed: number): Runtime =>
  ManagedRuntime.make(databaseLayer(openNodeDatabase().driver, Ids.layerSeeded(seed)));

const routines = <A, E>(
  runtime: Runtime,
  body: (repository: typeof RoutineRepository.Service) => Effect.Effect<A, E>,
) => runtime.runPromise(Effect.flatMap(Effect.service(RoutineRepository), body));

const routineTitle = (runtime: Runtime, id: RoutineId) =>
  routines(runtime, (repository) => repository.getRoutine(id)).then((detail) =>
    Option.getOrNull(Option.map(detail, ({ routine }) => routine.title)),
  );

const inProgress = (runtime: Runtime) => runtime.runPromise(loadWorkoutLog).then(Option.isSome);

let phone: Runtime;
let account: Runtime;
let id: RoutineId;
let tree: ReactTestRenderer | undefined;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(async () => {
  phone = openDatabase(1);
  account = openDatabase(2);
  app.databases.set("anonymous", phone);
  app.databases.set(ACCOUNT, account);
  app.alerts = [];
  switchOwner(ANONYMOUS);
  id = await routines(phone, (repository) =>
    repository.createRoutine({
      folderId: null,
      title: "Push",
      notes: "",
      position: 0,
      exercises: [
        {
          exerciseId: libraryExerciseId("Barbell_Squat"),
          supersetGroup: null,
          restS: null,
          notes: "",
          sets: [],
        },
      ],
    }),
  );
  // An import keeps the routine's ID, so the account holds a routine with the same one.
  const file = await phone.runPromise(
    Effect.flatMap(Effect.service(TransferRepository), (transfers) => transfers.exportFile),
  );
  await account.runPromise(
    Effect.flatMap(Effect.service(TransferRepository), (transfers) =>
      transfers.applyImport(Result.getOrThrow(decodeSvettFile(file.text)), []),
    ),
  );
  app.route.params = { id };
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  await Promise.all([phone.dispose(), account.dispose()]);
});

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function until(done: () => boolean, what: string, tries = 0): Promise<void> {
  if (done()) return;
  if (tries > 200) throw new Error(`${what} never happened`);
  await settle();
  return until(done, what, tries + 1);
}

const byTestID = (testID: string) => (node: ReactTestInstance) =>
  typeof node.type === "string" && node.props.testID === testID;

/** The routine screen's buttons as the phone's routine showed them, before anyone signed in. */
async function pressesOnThePhonesRoutine() {
  await act(async () => {
    tree = create(createElement(RoutineDetailScreen));
  });
  const root = tree!.root;
  await until(() => root.findAll(byTestID("routine-title")).length > 0, "the routine showing");
  const onPress = (testID: string) => root.find(byTestID(testID)).props.onPress as () => void;
  return { start: onPress("start-routine"), remove: onPress("delete-routine") };
}

const alerted = (title: string) => app.alerts.find((alert) => alert.title === title);

describe("a routine's buttons after someone signs in", () => {
  it("never start a workout in the account's database", async () => {
    const { start } = await pressesOnThePhonesRoutine();
    await act(async () => switchOwner({ kind: "account", accountId: ACCOUNT }));

    await act(async () => start());
    await until(() => alerted("The workout did not start") !== undefined, "the refusal");

    expect(alerted("The workout did not start")?.message).toContain(SWITCHED_BEFORE_WRITE);
    expect(await inProgress(account)).toBe(false);
    expect(await inProgress(phone)).toBe(false);
  });

  it("never delete the account's routine with the same ID", async () => {
    const { remove } = await pressesOnThePhonesRoutine();
    await act(async () => switchOwner({ kind: "account", accountId: ACCOUNT }));

    await act(async () => remove());
    const confirm = alerted("Delete Push?")?.buttons?.find((button) => button.text === "Delete");
    await act(async () => confirm?.onPress?.());
    await until(() => alerted("The routine was not changed") !== undefined, "the refusal");

    expect(alerted("The routine was not changed")?.message).toContain(SWITCHED_BEFORE_WRITE);
    expect(await routineTitle(account, id)).toBe("Push");
    expect(await routineTitle(phone, id)).toBe("Push");
  });
});
