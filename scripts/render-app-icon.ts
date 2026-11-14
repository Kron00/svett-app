import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

import { Resvg } from "@resvg/resvg-js";

const SIZE = 1024;
const source = new URL("../assets/icon.svg", import.meta.url);
const target = new URL("../apps/mobile/assets/icon.png", import.meta.url);

const rendered = new Resvg(readFileSync(source, "utf8"), {
  fitTo: { mode: "width", value: SIZE },
}).render();

if (rendered.width !== SIZE || rendered.height !== SIZE) {
  throw new Error(
    `Icon rendered at ${rendered.width}x${rendered.height}, expected ${SIZE}x${SIZE}`,
  );
}

const rgba = rendered.pixels;
const rowLength = 1 + SIZE * 3;
const scanlines = Buffer.alloc(rowLength * SIZE);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const from = (y * SIZE + x) * 4;
    const to = y * rowLength + 1 + x * 3;
    scanlines[to] = rgba[from]!;
    scanlines[to + 1] = rgba[from + 1]!;
    scanlines[to + 2] = rgba[from + 2]!;
  }
}

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
};

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;
header[9] = 2;

writeFileSync(
  target,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
console.log(`Wrote ${target.pathname} (${SIZE}x${SIZE}, RGB, no alpha)`);
