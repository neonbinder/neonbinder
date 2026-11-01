/**
 * Convex document-id codec (encode side), the same bytes as
 * `scripts/reference-seed/lib.mjs` and convex-backend's `id_v6.rs`:
 *
 *   bytes  = vint(tableNumber) ++ internalId[16] ++ footer[2]
 *   footer = fletcher16(vint ++ internalId), little-endian
 *   string = base32 (Crockford-style alphabet below, no padding)
 *
 * It exists so a Convex function can learn a table's NUMBER without a
 * snapshot export: `ctx.db.normalizeId(table, encodeId(n, zeros))` is
 * non-null exactly when `n` is that table's number (NEO-408).
 * `convexIdCodec.test.ts` pins it to the loader's codec.
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const DECODE = new Map([...ALPHABET].map((c, i) => [c, i] as const));

function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = ((buf << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buf >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(buf << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Uint8Array | null {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    const v = DECODE.get(ch);
    if (v === undefined) return null;
    buf = ((buf << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buf >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function fletcher16(bytes: Uint8Array): number {
  let c0 = 0;
  let c1 = 0;
  for (const b of bytes) {
    c0 = (c0 + b) & 0xff;
    c1 = (c1 + c0) & 0xff;
  }
  return (c1 << 8) | c0;
}

function vintEncode(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    if (n < 0x80) {
      out.push(n);
      return out;
    }
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
}

/** The id string for table number `table` and a 16-byte internal id. */
export function encodeId(table: number, internal: Uint8Array): string {
  if (!Number.isInteger(table) || table < 1) throw new Error("encodeId: table number must be a positive integer");
  if (internal.length !== 16) throw new Error("encodeId: internal id must be 16 bytes");
  const head = vintEncode(table);
  const body = Uint8Array.from([...head, ...internal]);
  const f = fletcher16(body);
  return base32Encode(Uint8Array.from([...body, f & 0xff, f >> 8]));
}

/** The table number encoded in a Convex id string, or null when it is not one. */
export function tableNumberOf(id: string): number | null {
  if (id.length < 31 || id.length > 37) return null;
  const buf = base32Decode(id);
  if (!buf) return null;
  let pos = 0;
  let n = 0;
  for (let i = 0; ; i++) {
    if (i >= 5 || pos >= buf.length) return null;
    const byte = buf[pos++];
    n += (byte & 0x7f) * 2 ** (7 * i);
    if (byte < 0x80) break;
  }
  if (n === 0 || buf.length !== pos + 16 + 2) return null;
  const footer = buf[pos + 16] | (buf[pos + 17] << 8);
  if (fletcher16(buf.subarray(0, pos + 16)) !== footer) return null;
  if (encodeId(n, buf.slice(pos, pos + 16)) !== id) return null;
  return n;
}

const ZERO_INTERNAL = new Uint8Array(16);

/**
 * Highest table number the scan tries before giving up on a table. Convex
 * numbers user tables upward from 10001, so a deployment with a few hundred
 * tables sits far below this; a table the scan never matches is reported
 * absent, and the loader refuses to guess.
 */
export const MAX_TABLE_NUMBER = 1 << 17;

/**
 * Tries every table number in [from, to) against `isIdOf` (`normalizeId` in
 * a Convex function) for the tables not yet in `known`. Returns the numbers
 * found in this range only. `normalizeId` is a syscall per call, so callers
 * scan in ranges small enough for one query and stop once every table is
 * found.
 */
export function findTableNumbers(
  tables: readonly string[],
  isIdOf: (table: string, id: string) => boolean,
  known: ReadonlyMap<string, number> = new Map(),
  from: number = 1,
  to: number = MAX_TABLE_NUMBER,
): Map<string, number> {
  const found = new Map<string, number>();
  const pending = tables.filter((t) => !known.has(t));
  for (let n = Math.max(1, from); n < to && pending.length > 0; n++) {
    const id = encodeId(n, ZERO_INTERNAL);
    for (let i = pending.length - 1; i >= 0; i--) {
      if (isIdOf(pending[i], id)) {
        found.set(pending[i], n);
        pending.splice(i, 1);
      }
    }
  }
  return found;
}
