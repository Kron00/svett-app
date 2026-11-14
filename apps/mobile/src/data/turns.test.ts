import { describe, expect, it } from "vite-plus/test";

import { inTurn, transferInTurn, transfersSettled } from "./turns";

const later = () => {
  const settle: { resolve?: (value: string) => void; reject?: (error: Error) => void } = {};
  const promise = new Promise<string>((resolve, reject) => {
    settle.resolve = resolve;
    settle.reject = reject;
  });
  return {
    promise,
    finish: (value: string) => settle.resolve?.(value),
    fail: (error: Error) => settle.reject?.(error),
  };
};

describe("turns", () => {
  it("starts a move only once the import being applied has finished", async () => {
    const order: Array<string> = [];
    const applying = later();
    const imported = transferInTurn(() => {
      order.push("import starts");
      return applying.promise;
    });
    const moved = inTurn(async () => {
      order.push("move starts");
      return "moved";
    });
    await Promise.resolve();
    expect(order).toEqual(["import starts"]);
    order.push("import ends");
    applying.finish("imported");
    expect(await imported).toBe("imported");
    expect(await moved).toBe("moved");
    expect(order).toEqual(["import starts", "import ends", "move starts"]);
  });

  it("starts the next task after one that failed", async () => {
    const applying = later();
    const undone = transferInTurn(() => applying.promise);
    const moved = inTurn(async () => "moved");
    applying.fail(new Error("the undo failed"));
    await expect(undone).rejects.toThrow("the undo failed");
    expect(await moved).toBe("moved");
  });

  it("waits for the import being applied before a database may close", async () => {
    const applying = later();
    void transferInTurn(() => applying.promise);
    await Promise.resolve();
    let settled = false;
    const closing = transfersSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    applying.fail(new Error("the import failed"));
    await closing;
    expect(settled).toBe(true);
  });
});
