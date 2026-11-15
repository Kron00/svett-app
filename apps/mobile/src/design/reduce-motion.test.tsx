import { act, create } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { useReduceMotion } from "./hooks";

const phone = vi.hoisted(() => ({
  reduceMotion: true,
  listeners: new Set<(enabled: boolean) => void>(),
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => phone.reduceMotion,
    addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
      phone.listeners.add(listener);
      return { remove: () => phone.listeners.delete(listener) };
    },
  },
  useWindowDimensions: () => ({ width: 440, height: 956, scale: 3, fontScale: 1 }),
}));
vi.mock("uniwind", () => ({ useCSSVariable: () => "#000000" }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: {} }));

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

describe("useReduceMotion", () => {
  it("follows the phone's Reduce Motion setting, also when it changes", async () => {
    const seen: Array<boolean> = [];
    function Probe() {
      seen.push(useReduceMotion());
      return null;
    }
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => {
      tree = create(<Probe />);
    });
    expect(seen.at(-1)).toBe(true);
    await act(async () => {
      for (const listener of phone.listeners) listener(false);
    });
    expect(seen.at(-1)).toBe(false);
    act(() => tree?.unmount());
    expect(phone.listeners.size).toBe(0);
  });
});
