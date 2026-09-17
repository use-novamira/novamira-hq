// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Derive the desktop application's Windows and Linux icons from the one
// committed master, `scripts/macos/icon.png`.
//
// The macOS path already does this with `sips` and `iconutil` inside
// `scripts/macos-sign.sh`, for exactly the reason repeated here: the master is
// the reviewable artefact and no derived size may drift from it. Apple's tools
// are on the macOS runner only, so the same rule needs a second implementation
// that runs on the Linux and Windows runners — and it is written against
// `node:zlib` and nothing else, because a build-time image dependency is a
// supply-chain surface for a file that changes once a year.
//
// Two conversions matter and are easy to get wrong:
//
//   * The master is Display P3 (`iCCP kCGColorSpaceDisplayP3`, `cICP 12/13/0/1`).
//     A Windows `.ico` carries no colour profile at all and is rendered as
//     sRGB, so the pixels are converted to sRGB here rather than reinterpreted
//     there. Reinterpreting is what "the icon looks oversaturated on Windows"
//     is.
//   * Downscaling averages light, not code values. The box filter runs on
//     linear, alpha-premultiplied samples; averaging gamma-encoded ones darkens
//     every edge in the image.

import { Buffer } from "node:buffer";
import { deflateSync, inflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath, URL } from "node:url";

/** The freedesktop icon theme sizes, and the `.ico` entry sizes. */
export const HICOLOR_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/**
 * Windows reads both encodings. Small entries are stored as the classic 32-bit
 * DIB every Windows shell has always understood, and the two large ones as PNG,
 * which is what Windows itself does and the only way a 256x256 entry stays a
 * sane size.
 */
const ICO_PNG_FROM = 128;

/** The icon name every generated file agrees on, and the `.desktop` Icon key. */
export const ICON_NAME = "novamira-hq";

// --- PNG ---------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** An 8-bit-per-channel RGBA raster, straight alpha. */
function chunks(png) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG file");
  }
  const found = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    found.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return found;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a non-interlaced truecolour-with-alpha PNG at 8 or 16 bits per
 * channel. That is the master's shape and the shape this script writes; a file
 * of any other shape is a mistake worth failing on rather than guessing at.
 */
function decodePng(png) {
  const parts = chunks(png);
  const header = parts.find((chunk) => chunk.type === "IHDR");
  if (header === undefined) throw new Error("PNG has no IHDR");
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const depth = header.data[8];
  const colour = header.data[9];
  const interlace = header.data[12];
  if (colour !== 6 || (depth !== 8 && depth !== 16) || interlace !== 0) {
    throw new Error(
      `unsupported PNG: colour type ${colour}, depth ${depth}, interlace ${interlace}`,
    );
  }

  const raw = inflateSync(
    Buffer.concat(
      parts.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data),
    ),
  );
  const bytes = depth === 16 ? 8 : 4;
  const stride = width * bytes;
  if (raw.length < (stride + 1) * height) {
    throw new Error("PNG image data is truncated");
  }

  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const line = lines.subarray(y * stride, (y + 1) * stride);
    const above = y === 0 ? null : lines.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytes ? line[x - bytes] : 0;
      const up = above === null ? 0 : above[x];
      const upLeft = above === null || x < bytes ? 0 : above[x - bytes];
      let value = source[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += up;
          break;
        case 3:
          value += (left + up) >> 1;
          break;
        case 4:
          value += paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      line[x] = value & 0xff;
    }
  }

  const samples = new Float32Array(width * height * 4);
  const max = depth === 16 ? 65535 : 255;
  for (let index = 0; index < width * height * 4; index += 1) {
    samples[index] =
      (depth === 16 ? lines.readUInt16BE(index * 2) : lines[index]) / max;
  }
  return { width, height, samples };
}

// --- colour ------------------------------------------------------------------

function toLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function toGamma(value) {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** Display P3 to sRGB, both D65, in linear light. */
const P3_TO_SRGB = [
  [1.2249401763, -0.2249401763, 0.0],
  [-0.0420569547, 1.0420569547, 0.0],
  [-0.0196375547, -0.0786360656, 1.0982736203],
];

function clamp(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * The master's pixels as linear sRGB, premultiplied by alpha — the space the
 * box filter below is allowed to average in.
 */
function toLinearSrgbPremultiplied({ width, height, samples }) {
  const out = new Float32Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const at = pixel * 4;
    const r = toLinear(samples[at]);
    const g = toLinear(samples[at + 1]);
    const b = toLinear(samples[at + 2]);
    const alpha = samples[at + 3];
    for (let channel = 0; channel < 3; channel += 1) {
      const [x, y, z] = P3_TO_SRGB[channel];
      out[at + channel] = (r * x + g * y + b * z) * alpha;
    }
    out[at + 3] = alpha;
  }
  return { width, height, samples: out };
}

// --- resampling ---------------------------------------------------------------

/**
 * Area-average box filter with fractional coverage, so a size that does not
 * divide the master's 1024 (24 and 48 do not) is resampled as correctly as one
 * that does.
 */
function resize(image, size) {
  const { width, height, samples } = image;
  const out = new Float32Array(size * size * 4);
  const scaleX = width / size;
  const scaleY = height / size;
  for (let y = 0; y < size; y += 1) {
    const top = y * scaleY;
    const bottom = (y + 1) * scaleY;
    for (let x = 0; x < size; x += 1) {
      const left = x * scaleX;
      const right = (x + 1) * scaleX;
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        total = 0;
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy += 1) {
        const coverY = Math.min(bottom, sy + 1) - Math.max(top, sy);
        if (coverY <= 0) continue;
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx += 1) {
          const coverX = Math.min(right, sx + 1) - Math.max(left, sx);
          if (coverX <= 0) continue;
          const weight = coverX * coverY;
          const at = (sy * width + sx) * 4;
          r += samples[at] * weight;
          g += samples[at + 1] * weight;
          b += samples[at + 2] * weight;
          a += samples[at + 3] * weight;
          total += weight;
        }
      }
      const at = (y * size + x) * 4;
      out[at] = r / total;
      out[at + 1] = g / total;
      out[at + 2] = b / total;
      out[at + 3] = a / total;
    }
  }
  return { width: size, height: size, samples: out };
}

/** Back to 8-bit gamma-encoded sRGB with straight alpha. */
function toRgba8({ width, height, samples }) {
  const out = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const at = pixel * 4;
    const alpha = clamp(samples[at + 3]);
    for (let channel = 0; channel < 3; channel += 1) {
      const straight = alpha === 0 ? 0 : samples[at + channel] / alpha;
      out[at + channel] = Math.round(clamp(toGamma(clamp(straight))) * 255);
    }
    out[at + 3] = Math.round(alpha * 255);
  }
  return { width, height, pixels: out };
}

// --- encoding -----------------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    // These pixels are sRGB now, and say so: the master's Display P3 profile
    // would be a lie about them.
    chunk("sRGB", Buffer.from([0])),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 32-bit bottom-up DIB with the all-zero AND mask a 32bpp icon carries. */
function encodeDib({ width, height, pixels }) {
  const maskStride = Math.ceil(width / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // colour rows plus mask rows
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(width * height * 4 + maskStride * height, 20);
  const colour = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const source = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x += 1) {
      const from = source + x * 4;
      const to = (y * width + x) * 4;
      colour[to] = pixels[from + 2];
      colour[to + 1] = pixels[from + 1];
      colour[to + 2] = pixels[from];
      colour[to + 3] = pixels[from + 3];
    }
  }
  return Buffer.concat([header, colour, Buffer.alloc(maskStride * height)]);
}

function encodeIco(entries) {
  const directory = Buffer.alloc(6 + entries.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2); // an icon, not a cursor
  directory.writeUInt16LE(entries.length, 4);
  let offset = directory.length;
  const bodies = [];
  entries.forEach(({ size, data }, index) => {
    const at = 6 + index * 16;
    directory[at] = size >= 256 ? 0 : size;
    directory[at + 1] = size >= 256 ? 0 : size;
    directory[at + 2] = 0; // not palettised
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
    bodies.push(data);
  });
  return Buffer.concat([directory, ...bodies]);
}

// --- the generator ------------------------------------------------------------

/**
 * Write the Windows `.ico` and the freedesktop hicolor tree below `outDir`.
 * Returns every path written, so a caller can assemble them without repeating
 * the layout.
 */
export async function generateIcons({ master, outDir }) {
  const source = decodePng(await readFile(master));
  if (source.width !== source.height) {
    throw new Error("the master icon must be square");
  }
  const linear = toLinearSrgbPremultiplied(source);

  const rasters = new Map();
  for (const size of new Set([...HICOLOR_SIZES, ...ICO_SIZES])) {
    if (size > source.width) {
      throw new Error(
        `the master icon is ${source.width}px and cannot produce ${size}px`,
      );
    }
    rasters.set(size, toRgba8(resize(linear, size)));
  }

  const written = [];
  const write = async (relative, data) => {
    const path = join(outDir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    written.push(path);
  };

  await write(
    `${ICON_NAME}.ico`,
    encodeIco(
      ICO_SIZES.map((size) => ({
        size,
        data:
          size >= ICO_PNG_FROM
            ? encodePng(rasters.get(size))
            : encodeDib(rasters.get(size)),
      })),
    ),
  );
  for (const size of HICOLOR_SIZES) {
    await write(
      join("hicolor", `${size}x${size}`, "apps", `${ICON_NAME}.png`),
      encodePng(rasters.get(size)),
    );
  }
  return written;
}

/** Keep the macOS icon's silhouette inside an 824px square on a 1024px canvas. */
export async function generateMacIcon({ master, output }) {
  const source = decodePng(await readFile(master));
  if (source.width !== 1024 || source.height !== 1024)
    throw new Error("macOS icon master must be 1024x1024");
  const inset = 100;
  const inner = toRgba8(resize(toLinearSrgbPremultiplied(source), 824));
  const pixels = Buffer.alloc(1024 * 1024 * 4);
  for (let row = 0; row < inner.height; row++)
    pixels.set(
      inner.pixels.subarray(row * inner.width * 4, (row + 1) * inner.width * 4),
      ((row + inset) * 1024 + inset) * 4,
    );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encodePng({ width: 1024, height: 1024, pixels }));
  return output;
}

if (import.meta.url === new URL(`file://${argv[1]}`).href) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const outDir = argv[2] ?? join(root, "dist-desktop", "icons");
  try {
    if (argv[2] === "--macos") {
      if (!argv[3]) throw new Error("--macos requires an output PNG path");
      await generateMacIcon({
        master: join(root, "scripts/macos/icon.png"),
        output: argv[3],
      });
      exit(0);
    }
    const written = await generateIcons({
      master: join(root, "scripts", "macos", "icon.png"),
      outDir,
    });
    stdout.write(`Generated ${written.length} desktop icons in ${outDir}\n`);
  } catch (error) {
    stderr.write(`desktop-icons: ${error.message}\n`);
    exit(1);
  }
}
