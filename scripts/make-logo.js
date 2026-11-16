/**
 * 生成 plugin.json 里 logo 指向的 PNG（256×256，圆角渐变底 + 剪贴板图标）。
 * 纯 Node 实现，不依赖任何第三方库：node scripts/make-logo.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 256;
const RADIUS = 52;

function mix(from, to, t) { return Math.round(from + (to - from) * t); }

function insideRounded(x, y) {
  const r = RADIUS;
  const left = r, right = SIZE - r, top = r, bottom = SIZE - r;
  if (x >= left && x <= right) return y >= 0 && y <= SIZE;
  if (y >= top && y <= bottom) return x >= 0 && x <= SIZE;
  const cx = x < left ? left : right;
  const cy = y < top ? top : bottom;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRect(x, y, rx, ry, rw, rh) { return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh; }

function inRoundRect(x, y, rx, ry, rw, rh, rad) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const r = Math.min(rad, rw / 2, rh / 2);
  const left = rx + r, right = rx + rw - r, top = ry + r, bottom = ry + rh - r;
  if (x >= left && x <= right) return true;
  if (y >= top && y <= bottom) return true;
  const cx = x < left ? left : right;
  const cy = y < top ? top : bottom;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRingRoundRect(x, y, rx, ry, rw, rh, rad, t) {
  if (!inRoundRect(x, y, rx, ry, rw, rh, rad)) return false;
  return !inRoundRect(x, y, rx + t, ry + t, rw - 2 * t, rh - 2 * t, Math.max(0, rad - t));
}

function clipboardIcon(x, y) {
  // board outline
  if (inRingRoundRect(x, y, 72, 66, 112, 132, 16, 10)) return true;
  // clip
  if (inRingRoundRect(x, y, 104, 46, 48, 36, 10, 8)) return true;
  // clip stem
  if (inRect(x, y, 118, 74, 20, 10)) return true;
  // lines
  if (inRect(x, y, 98, 112, 60, 8)) return true;
  if (inRect(x, y, 98, 136, 60, 8)) return true;
  if (inRect(x, y, 98, 160, 44, 8)) return true;
  return false;
}

function buildPixels() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      if (!insideRounded(x, y)) continue;
      const isIcon = clipboardIcon(x, y);
      if (isIcon) {
        pixels[offset] = 255; pixels[offset + 1] = 255; pixels[offset + 2] = 255; pixels[offset + 3] = 255;
      } else {
        const t = y / (SIZE - 1);
        pixels[offset] = mix(37, 29, t);
        pixels[offset + 1] = mix(99, 78, t);
        pixels[offset + 2] = mix(235, 216, t);
        pixels[offset + 3] = 255;
      }
    }
  }
  return pixels;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = SIZE * 4 + 1;
  const raw = Buffer.alloc(stride * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const output = path.join(__dirname, "..", "logo.png");
fs.writeFileSync(output, encodePng(buildPixels()));
console.log("logo 已生成：" + output);
