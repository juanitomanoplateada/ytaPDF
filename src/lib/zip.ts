/**
 * A minimal ZIP writer. Files are stored without compression: PDFs and images
 * are already compressed, so deflating them again would cost time for almost
 * no gain, and storing keeps this free of dependencies.
 */

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

export function crc32(bytes: Uint8Array): number {
  const t = table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = t[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Date and time in MS-DOS format, as ZIP headers store them. */
function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Makes names safe and unique inside the archive ("a.pdf", "a (2).pdf"…).
 * Folders ("imagenes/1.png") are kept; absolute paths and ".." are not.
 */
function uniqueNames(entries: ZipEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map(({ name }) => {
    const clean =
      name
        .replaceAll("\\", "/")
        .split("/")
        .filter((part) => part && part !== "." && part !== "..")
        .join("/") || "archivo";
    const count = (seen.get(clean.toLowerCase()) ?? 0) + 1;
    seen.set(clean.toLowerCase(), count);
    if (count === 1) return clean;
    const dot = clean.lastIndexOf(".");
    return dot > 0 ? `${clean.slice(0, dot)} (${count})${clean.slice(dot)}` : `${clean} (${count})`;
  });
}

/**
 * Reads the files of a ZIP archive: stored ones (as this module writes them)
 * and deflated ones, when the browser can inflate them.
 */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-directory record is in the last 64 KiB (a comment may follow it).
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("No es un archivo ZIP.");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("ZIP dañado.");
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.slice(dataStart, dataStart + compressed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflateRaw(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function createZip(entries: ZipEntry[], date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(date);
  const names = uniqueNames(entries).map((name) => encoder.encode(name));

  let size = 22;
  entries.forEach((entry, i) => (size += 30 + names[i].length + entry.bytes.length + 46 + names[i].length));
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  const central: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];

  // Bit 11 marks names as UTF-8, so accents survive in every unzipper.
  const FLAGS = 0x0800;
  entries.forEach((entry, i) => {
    const name = names[i];
    const crc = crc32(entry.bytes);
    central.push({ name, crc, size: entry.bytes.length, offset });
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, FLAGS, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, day, true);
    view.setUint32(offset + 14, crc, true);
    view.setUint32(offset + 18, entry.bytes.length, true);
    view.setUint32(offset + 22, entry.bytes.length, true);
    view.setUint16(offset + 26, name.length, true);
    view.setUint16(offset + 28, 0, true);
    out.set(name, offset + 30);
    out.set(entry.bytes, offset + 30 + name.length);
    offset += 30 + name.length + entry.bytes.length;
  });

  const centralStart = offset;
  for (const file of central) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, FLAGS, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, day, true);
    view.setUint32(offset + 16, file.crc, true);
    view.setUint32(offset + 20, file.size, true);
    view.setUint32(offset + 24, file.size, true);
    view.setUint16(offset + 28, file.name.length, true);
    // Extra field, comment, disk number, internal and external attributes: none.
    view.setUint32(offset + 42, file.offset, true);
    out.set(file.name, offset + 46);
    offset += 46 + file.name.length;
  }

  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, central.length, true);
  view.setUint16(offset + 10, central.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  return out;
}
