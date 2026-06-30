/**
 * extension-pack.ts — Zip the browser-extension folder on demand.
 * ───────────────────────────────────────────────────────────────────────────
 * Lets the admin download the connector extension straight from the MCP Connect
 * panel. Implements a minimal STORED (uncompressed) ZIP writer so there's no
 * external dependency — the extension is a handful of small text files.
 */

import fs from 'node:fs';
import path from 'node:path';

// The extension files ship inside the backend (backend/extension), so they are
// present in the standalone backend image too. Resolved from the process CWD,
// which is the backend root both in dev (npm run dev) and in the container
// (WORKDIR /app/backend). Override with EXTENSION_DIR if needed.
const EXTENSION_DIR = process.env.EXTENSION_DIR
  ? path.resolve(process.env.EXTENSION_DIR)
  : path.resolve(process.cwd(), 'extension');

// ── CRC-32 (ZIP requires it per entry) ───────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] as number;
    c = ((CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface FileEntry {
  name: string; // forward-slash relative path inside the zip
  data: Buffer;
}

function collect(dir: string, base = ''): FileEntry[] {
  const out: FileEntry[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...collect(abs, rel));
    else if (ent.isFile()) out.push({ name: rel, data: fs.readFileSync(abs) });
  }
  return out;
}

export function extensionExists(): boolean {
  return fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'));
}

/** Build a STORED .zip of the extension folder. */
export function buildExtensionZip(): Buffer {
  const files = collect(EXTENSION_DIR);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    locals.push(local, nameBuf, f.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + f.data.length;
  }

  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8); // entries on this disk
  end.writeUInt16LE(files.length, 10); // total entries
  end.writeUInt32LE(centralBlob.length, 12); // central dir size
  end.writeUInt32LE(localBlob.length, 16); // central dir offset
  end.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([localBlob, centralBlob, end]);
}
