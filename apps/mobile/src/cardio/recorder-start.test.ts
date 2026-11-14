import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const phone = vi.hoisted(() => ({
  journal: "",
  permission: undefined as Error | undefined,
  granted: true,
  gps: undefined as Error | undefined,
  started: false,
}));

vi.mock("expo-file-system", () => ({
  Paths: { document: "/documents" },
  File: class {
    get exists() {
      return phone.journal !== "";
    }
    textSync() {
      return phone.journal;
    }
    async write(text: string) {
      phone.journal += text;
    }
    delete() {
      phone.journal = "";
    }
  },
}));
vi.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: async () => {
    if (phone.permission !== undefined) throw phone.permission;
    return { granted: phone.granted };
  },
  requestBackgroundPermissionsAsync: async () => ({ granted: false }),
  hasStartedLocationUpdatesAsync: async () => phone.started,
  startLocationUpdatesAsync: async () => {
    if (phone.gps !== undefined) throw phone.gps;
    phone.started = true;
  },
  stopLocationUpdatesAsync: async () => {
    phone.started = false;
  },
  Accuracy: { BestForNavigation: 6 },
  ActivityType: { Fitness: 3 },
}));
vi.mock("expo-task-manager", () => ({ defineTask: () => undefined }));
vi.mock("../data/database", async () => {
  const effect = await import("effect");
  const { databaseLayer, Ids } = await import("@svett/core");
  const { openNodeDatabase } = await import("@svett/core/node");
  const runtime = effect.ManagedRuntime.make(
    databaseLayer(openNodeDatabase().driver, Ids.layerSeeded(3)),
  );
  return { appDatabase: () => runtime };
});

const { discardRecording, recording, startRecording } = await import("./recorder");

describe("starting a recording", () => {
  beforeEach(async () => {
    await discardRecording();
    Object.assign(phone, { permission: undefined, granted: true, gps: undefined });
  });

  it("starts when location is allowed and GPS starts", async () => {
    expect(await startRecording("run")).toEqual({ kind: "started" });
    expect(recording.get()?.kind).toBe("run");
    expect(phone.started).toBe(true);
  });

  it("says location was denied", async () => {
    phone.granted = false;
    expect(await startRecording("walk")).toEqual({ kind: "denied" });
    expect(recording.get()).toBeUndefined();
  });

  it("reports a permission request that fails, instead of leaving Start waiting", async () => {
    phone.permission = new Error("The operation couldn't be completed. (kCLErrorDomain error 0.)");
    expect(await startRecording("run")).toEqual({
      kind: "error",
      step: "permission",
      message: "The operation couldn't be completed. (kCLErrorDomain error 0.)",
    });
    expect(recording.get()).toBeUndefined();
  });

  it("reports GPS that will not start with the recorder's step and reason", async () => {
    phone.gps = new Error("Location services are disabled");
    expect(await startRecording("ride")).toEqual({
      kind: "error",
      step: "location",
      message: "Location services are disabled",
    });
    expect(recording.get()).toBeUndefined();
    expect(phone.journal).toBe("");
  });
});
