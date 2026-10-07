/**
 * Glyphs to erase are written as "<path><op>:<from>-<to>" ranges: glyphs
 * `from` to `to` of operation `op` of the content at `path` ("" for the
 * page, "12/" for the form drawn by operation 12, and so on).
 */

export function compressRanges(glyphs: { path: string; op: number; index: number }[]): string[] {
  const byOp = new Map<string, number[]>();
  for (const g of glyphs) {
    const key = `${g.path}${g.op}`;
    const list = byOp.get(key) ?? [];
    list.push(g.index);
    byOp.set(key, list);
  }
  const ranges: string[] = [];
  for (const [op, indices] of byOp) {
    indices.sort((a, b) => a - b);
    let from = indices[0];
    let to = from;
    for (const index of indices.slice(1)) {
      if (index === to + 1) {
        to = index;
        continue;
      }
      ranges.push(`${op}:${from}-${to}`);
      from = to = index;
    }
    ranges.push(`${op}:${from}-${to}`);
  }
  return ranges;
}

/** Reads ranges back into operation → glyph indices. */
export function parseEraseRanges(ranges: string[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const range of ranges) {
    const match = /^(.*):(\d+)-(\d+)$/.exec(range);
    if (!match) continue;
    const set = result.get(match[1]) ?? new Set<number>();
    for (let i = Number(match[2]); i <= Number(match[3]); i++) set.add(i);
    result.set(match[1], set);
  }
  return result;
}
