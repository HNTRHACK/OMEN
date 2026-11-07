// Billboard image uploads. Only real PNG and JPEG are accepted, identified by their bytes (never by
// file name or a claimed type), with dimensions read from the headers. No SVG (it can carry script),
// no GIF, nothing else. The browser re-encodes images before upload, which also strips EXIF/GPS.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const MAX_BYTES = 700 * 1024;
export const MAX_SIDE = 2048;

/** Fully decode and re-encode uploads on the server; never trust browser metadata stripping. */
export async function normalizeImage(dataUrl) {
  const { buf, info } = checkImage(dataUrl);
  const { default: sharp } = await import('sharp');
  try {
    const image = sharp(buf, { limitInputPixels: MAX_SIDE * MAX_SIDE, failOn: 'warning' });
    const output = info.ext === 'png' ? await image.png().toBuffer() : await image.jpeg({ quality: 85 }).toBuffer();
    if (output.length > MAX_BYTES) throw new Error('Encoded image too large');
    return `data:${info.type};base64,${output.toString('base64')}`;
  } catch {
    throw Object.assign(new Error('The image could not be decoded safely.'), { status: 400, code: 'bad_image' });
  }
}

export function sniff(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString("ascii", 12, 16) === "IHDR")
    return { type: "image/png", ext: "png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    // walk JPEG segments to the first start-of-frame marker for the size
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf))
        return { type: "image/jpeg", ext: "jpg", h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

/** Validate a data URL from the browser without storing anything. Returns { buf, info }. */
export function checkImage(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw Object.assign(new Error("Upload a PNG or JPEG image."), { status: 400, code: "bad_image" });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_BYTES) throw Object.assign(new Error("That image is too large (700 KB max after resizing)."), { status: 413, code: "too_large" });
  const info = sniff(buf);
  if (!info) throw Object.assign(new Error("That file isn't a real PNG or JPEG image."), { status: 400, code: "bad_image" });
  if (!(info.w >= 64 && info.h >= 64 && info.w <= MAX_SIDE && info.h <= MAX_SIDE)) throw Object.assign(new Error(`Images must be 64–${MAX_SIDE} px on each side.`), { status: 400, code: "bad_size" });
  return { buf, info };
}

/** Store a checked image under a random name. Returns { file, type, w, h }. */
export function storeImage(dir, { buf, info }) {
  const file = `${randomBytes(16).toString("hex")}.${info.ext}`;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), buf);
  }
  return { file, type: info.type, w: info.w, h: info.h, bytes: buf.length };
}

/** Validate and store in one step. */
export const saveImage = (dir, dataUrl) => storeImage(dir, checkImage(dataUrl));

/** Serve a stored upload: strict name check, fixed type, no sniffing, no scripts. */
export function serveUpload(dir, name, res) {
  const m = /^([a-f0-9]{32})\.(png|jpg)$/.exec(name);
  const path = m && dir ? join(dir, name) : null;
  if (!path || !existsSync(path)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": m[2] === "png" ? "image/png" : "image/jpeg",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "public, max-age=86400, immutable",
  });
  res.end(readFileSync(path));
}
