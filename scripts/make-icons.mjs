#!/usr/bin/env node
/**
 * Draw Sonde's app icon and write it out as PNGs — no image library involved.
 *
 * PNG is a container around zlib-compressed scanlines, and node ships zlib, so
 * the whole encoder is a few dozen lines. The artwork is computed per pixel
 * (rounded square, diamond ring) with 3× supersampling for smooth edges.
 */
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------- PNG ------------------------------- */

function crc32(buf) {
  let c;
  const table = crc32.table ??= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @param {Uint8Array} rgba raw RGBA pixels, width*height*4 */
function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;      // bit depth
  header[9] = 6;      // colour type: RGBA
  header[10] = 0;     // deflate
  header[11] = 0;     // adaptive filtering
  header[12] = 0;     // no interlace

  // Each scanline is prefixed with its filter type; 0 = none.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ artwork ------------------------------ */

const ACCENT = [0xff, 0x7a, 0x45];
const INK = [0x1b, 0x1c, 0x1f];

/** Signed coverage test for a rounded square, in 0..1 unit space. */
function inRoundedSquare(x, y, radius) {
  const inset = 0.06;
  const lo = inset;
  const hi = 1 - inset;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 + 1e-9;
}

/** Diamond: |dx| + |dy| <= size, in unit space centred on 0.5. */
const inDiamond = (x, y, size) => Math.abs(x - 0.5) + Math.abs(y - 0.5) <= size;

function render(size) {
  const rgba = new Uint8Array(size * size * 4);
  const samples = 3;
  const radius = 0.20;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let markHits = 0;

      // Supersample so the curves and diagonals don't come out jagged.
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (inRoundedSquare(x, y, radius)) bgHits++;
          // A diamond ring: outer filled, inner punched back out.
          if (inDiamond(x, y, 0.30) && !inDiamond(x, y, 0.155)) markHits++;
        }
      }

      const total = samples * samples;
      const bgAlpha = bgHits / total;
      const markAlpha = (markHits / total) * bgAlpha;

      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        // Mark painted over the accent background, then the whole thing
        // composited against transparency.
        rgba[i + c] = Math.round(ACCENT[c] * (1 - markAlpha / (bgAlpha || 1)) + INK[c] * (markAlpha / (bgAlpha || 1)));
      }
      rgba[i + 3] = Math.round(bgAlpha * 255);
    }
  }
  return rgba;
}

export function iconPng(size) {
  return encodePng(render(size), size, size);
}

/* ------------------------------- main ------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = path.join(process.cwd(), 'public', 'icons');
  await fs.mkdir(outDir, { recursive: true });
  for (const size of [32, 180, 192, 512]) {
    await fs.writeFile(path.join(outDir, `icon-${size}.png`), iconPng(size));
    console.log(`  public/icons/icon-${size}.png`);
  }
  console.log('icons written');
}
