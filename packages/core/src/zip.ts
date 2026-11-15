import { Data } from "effect";
import { DecodeUTF8, Inflate, strFromU8 } from "fflate";

/** A file read in pieces, so a file of hundreds of megabytes never sits in memory whole. */
export interface ByteSource {
  readonly size: number;
  readonly read: (offset: number, length: number) => Promise<Uint8Array>;
}

export class ZipError extends Data.TaggedError("ZipError")<{ readonly message: string }> {}

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
}

const CHUNK = 1 << 20;
const MAX_U32 = 0xffffffff;

/** A ByteSource over bytes already in memory, for tests and small files. */
export const bytesSource = (bytes: Uint8Array): ByteSource => ({
  size: bytes.length,
  read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
});

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u64 = (data: DataView, at: number) =>
  data.getUint32(at, true) + data.getUint32(at + 4, true) * 2 ** 32;

const readExactly = async (source: ByteSource, offset: number, length: number) => {
  const bytes = await source.read(offset, length);
  if (bytes.length < length) throw new ZipError({ message: "The zip file is cut short." });
  return bytes;
};

/**
 * Reads `length` bytes from `start`, a megabyte at a time, each read after the last one
 * finished, so only one piece is in memory. `onBytes` also gets how much is read so far.
 */
export const readRange = async (
  source: ByteSource,
  start: number,
  length: number,
  onBytes: (bytes: Uint8Array, read: number) => void,
  read = 0,
): Promise<void> => {
  if (read >= length) return;
  const bytes = await readExactly(source, start + read, Math.min(CHUNK, length - read));
  onBytes(bytes, read + bytes.length);
  return readRange(source, start, length, onBytes, read + bytes.length);
};

/** Runs `task` on each item, one after another, for work that must not overlap. */
export const inSequence = async <A, B>(
  items: ReadonlyArray<A>,
  task: (item: A) => Promise<B>,
): Promise<Array<B>> => {
  const results: Array<B> = [];
  await items.reduce(
    (previous, item) => previous.then(async () => void results.push(await task(item))),
    Promise.resolve(),
  );
  return results;
};

/** Whether the bytes start like a zip file. */
export const isZip = (start: Uint8Array): boolean =>
  start.length >= 4 && start[0] === 0x50 && start[1] === 0x4b && start[2] === 3 && start[3] === 4;

/** Lists a zip's files from its central directory, including zip64 archives over 4 GB. */
export const listZipEntries = async (source: ByteSource): Promise<ReadonlyArray<ZipEntry>> => {
  const tailLength = Math.min(source.size, 22 + 0xffff);
  const tailStart = source.size - tailLength;
  const tail = await readExactly(source, tailStart, tailLength);
  const tailView = view(tail);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tailView.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end === -1) throw new ZipError({ message: "This is not a zip file." });
  let count = tailView.getUint16(end + 10, true);
  let directorySize = tailView.getUint32(end + 12, true);
  let directoryOffset = tailView.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === MAX_U32 || directoryOffset === MAX_U32) {
    const locator = end - 20;
    if (locator < 0 || tailView.getUint32(locator, true) !== 0x07064b50) {
      throw new ZipError({ message: "The zip file's directory is damaged." });
    }
    const record = view(await readExactly(source, u64(tailView, locator + 8), 56));
    if (record.getUint32(0, true) !== 0x06064b50) {
      throw new ZipError({ message: "The zip file's directory is damaged." });
    }
    count = u64(record, 32);
    directorySize = u64(record, 40);
    directoryOffset = u64(record, 48);
  }
  const directory = await readExactly(source, directoryOffset, directorySize);
  const data = view(directory);
  const entries: Array<ZipEntry> = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directory.length || data.getUint32(at, true) !== 0x02014b50) {
      throw new ZipError({ message: "The zip file's directory is damaged." });
    }
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    let size = data.getUint32(at + 24, true);
    let compressedSize = data.getUint32(at + 20, true);
    let localHeaderOffset = data.getUint32(at + 42, true);
    const name = strFromU8(directory.subarray(at + 46, at + 46 + nameLength));
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = data.getUint16(extra, true);
      const length = data.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let field = extra + 4;
        if (size === MAX_U32) {
          size = u64(data, field);
          field += 8;
        }
        if (compressedSize === MAX_U32) {
          compressedSize = u64(data, field);
          field += 8;
        }
        if (localHeaderOffset === MAX_U32) localHeaderOffset = u64(data, field);
      }
      extra += 4 + length;
    }
    entries.push({
      name,
      method: data.getUint16(at + 10, true),
      compressedSize,
      size,
      localHeaderOffset,
    });
    at = extraEnd + commentLength;
  }
  return entries;
};

/**
 * Hands over one file's bytes as they are inflated, a megabyte of the zip at a time.
 * `onProgress` gets the share of the file read so far.
 */
export const readZipEntry = async (
  source: ByteSource,
  entry: ZipEntry,
  onBytes: (bytes: Uint8Array) => void,
  onProgress?: (fraction: number) => void,
): Promise<void> => {
  const header = view(await readExactly(source, entry.localHeaderOffset, 30));
  if (header.getUint32(0, true) !== 0x04034b50) {
    throw new ZipError({ message: `The zip file's entry ${entry.name} is damaged.` });
  }
  const start =
    entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError({
      message: `svett cannot unpack ${entry.name}, as it uses another kind of compression.`,
    });
  }
  const inflate = entry.method === 8 ? new Inflate((bytes) => onBytes(bytes)) : undefined;
  await readRange(source, start, entry.compressedSize, (bytes, read) => {
    if (inflate === undefined) onBytes(bytes);
    else {
      try {
        inflate.push(bytes, read === entry.compressedSize);
      } catch {
        throw new ZipError({ message: `The zip file's entry ${entry.name} is damaged.` });
      }
    }
    onProgress?.(read / entry.compressedSize);
  });
  if (entry.compressedSize === 0) inflate?.push(new Uint8Array(0), true);
};

/** Hands over one file's text as it is inflated, decoded as UTF-8. */
export const readZipText = (
  source: ByteSource,
  entry: ZipEntry,
  onText: (text: string) => void,
  onProgress?: (fraction: number) => void,
): Promise<void> => {
  const decoder = new DecodeUTF8((text) => {
    if (text !== "") onText(text);
  });
  return readZipEntry(source, entry, (bytes) => decoder.push(bytes), onProgress).then(() =>
    decoder.push(new Uint8Array(0), true),
  );
};

/** One whole file of the zip as text, for small files such as a route. */
export const zipText = async (source: ByteSource, entry: ZipEntry): Promise<string> => {
  const parts: Array<string> = [];
  await readZipText(source, entry, (text) => parts.push(text));
  return parts.join("");
};
