import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Clock, Context, Effect, Layer, Schema } from "effect";

export const Uuid = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("Uuid"));
export type Uuid = typeof Uuid.Type;

const decodeUuid = Schema.decodeSync(Uuid);

const formatUuid = (bytes: Uint8Array): Uuid => {
  const hex = bytesToHex(bytes.subarray(0, 16));
  return decodeUuid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

const parseUuid = (uuid: string): Uint8Array => {
  const hex = uuid.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

/** RFC 9562 version 7: 48 bits of Unix milliseconds, then 74 random bits taken from `random`. */
export const uuidV7 = (unixMillis: number, random: Uint8Array): Uuid => {
  const bytes = new Uint8Array(16);
  let time = Math.floor(unixMillis);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 | ((random[0] ?? 0) & 0x0f);
  bytes[7] = random[1] ?? 0;
  bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
  for (let index = 9; index < 16; index++) bytes[index] = random[index - 6] ?? 0;
  return formatUuid(bytes);
};

/** RFC 9562 version 5: the same namespace and name always give the same UUID. */
export const uuidV5 = (namespace: string, name: string): Uuid => {
  const nameBytes = utf8ToBytes(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(parseUuid(namespace));
  input.set(nameBytes, 16);
  const hash = sha1(input);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(hash);
};

const SVETT_NAMESPACE = "bed1957d-954d-4423-b6c5-ab7fa1d32366";

/**
 * The ID of a row that came from outside, such as a Hevy workout or a library exercise.
 * Two devices that import the same thing compute the same ID, so sync sees one row.
 */
export const importedId = (source: string, identity: string): Uuid =>
  uuidV5(SVETT_NAMESPACE, JSON.stringify([source, identity]));

/** A stable fingerprint of a row's content, used to tell a changed import from an unchanged one. */
export const contentFingerprint = (content: unknown): string =>
  bytesToHex(sha256(utf8ToBytes(canonicalJson(content))));

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Mulberry32. Small, fast and deterministic. Never use it where IDs must be unguessable. */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Makes the random IDs of rows created on this device. */
export class Ids extends Context.Service<Ids, { readonly random: Effect.Effect<Uuid> }>()(
  "svett/Ids",
) {
  static readonly layer = (fillRandom: (bytes: Uint8Array) => void): Layer.Layer<Ids> =>
    Layer.succeed(Ids, {
      random: Effect.map(Clock.currentTimeMillis, (now) => {
        const random = new Uint8Array(10);
        fillRandom(random);
        return uuidV7(now, random);
      }),
    });

  static readonly layerSeeded = (seed: number): Layer.Layer<Ids> =>
    Layer.sync(Ids, () => {
      const next = seededRandom(seed);
      return Ids.of({
        random: Effect.map(Clock.currentTimeMillis, (now) =>
          uuidV7(
            now,
            Uint8Array.from({ length: 10 }, () => Math.floor(next() * 256)),
          ),
        ),
      });
    });
}
