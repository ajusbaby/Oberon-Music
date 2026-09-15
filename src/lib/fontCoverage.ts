// 字体覆盖检测：解析字体文件的 cmap，得到"这个字体到底有哪些字形"。
//
// 为什么需要它：`unicode-range` 只声明"这个字面**愿意**服务哪些码位"，管不了
// "这个字面**有没有**这个字形"。日文字体放进中文槽时，简体字大面积缺失 → 浏览器逐字
// 回退到系统正体 → 一行里两种字体。要避免这种混排，先得知道"覆盖了什么"。
//
// 支持 TTF / OTF / TTC 的 cmap format 12 / 4 / 6 / 0（format 4 会判定非零 glyphId）。
// 不支持 WOFF / WOFF2（压缩容器，返回 null → 上层显示"未检测"，绝不因此改渲染行为）。

/** 扁平区间表：[start0,end0, start1,end1, ...] 闭区间，按 start 升序、互不相邻 */
export interface Coverage {
  ranges: number[];
  /** 覆盖的码位总数（区间长度之和） */
  count: number;
}

/** 区间表里是否含某个码位（二分） */
export function covers(cov: Coverage, cp: number): boolean {
  const r = cov.ranges;
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < r[mid * 2]) hi = mid - 1;
    else if (cp > r[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** 一段文本里有多少个码位不被覆盖（同码位只算一次） */
export function missingIn(cov: Coverage, text: string): string[] {
  const seen = new Set<number>();
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp == null || cp === 0x20 || seen.has(cp)) continue;
    seen.add(cp);
    if (!covers(cov, cp)) out.push(ch);
  }
  return out;
}

/** 区间数量上限：防止畸形字体把内存吃光 */
const MAX_RANGES = 400000;

function toCoverage(raw: [number, number][]): Coverage | null {
  if (!raw.length) return { ranges: [], count: 0 };
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: number[] = [];
  let count = 0;
  let [cs, ce] = raw[0];
  for (let i = 1; i < raw.length; i++) {
    const [s, e] = raw[i];
    if (s <= ce + 1) {
      if (e > ce) ce = e;
    } else {
      out.push(cs, ce);
      count += ce - cs + 1;
      cs = s;
      ce = e;
    }
  }
  out.push(cs, ce);
  count += ce - cs + 1;
  return { ranges: out, count };
}

export function parseCmap(buf: ArrayBuffer): Coverage | null {
  if (buf.byteLength < 12) return null;
  const d = new DataView(buf);
  const len = buf.byteLength;
  const u16 = (o: number) => d.getUint16(o, false);
  const u32 = (o: number) => d.getUint32(o, false);
  const tag = u32(0);
  // wOFF / wOF2：压缩容器，这里不解（解压要 Brotli，浏览器没有这个 API）
  if (tag === 0x774f4646 || tag === 0x774f4632) return null;
  let base = 0;
  if (tag === 0x74746366) {
    // ttcf：一个文件里多张字体，取第一张（浏览器默认也是第一张）
    if (len < 16) return null;
    base = u32(12);
    if (base + 12 > len) return null;
  }
  const numTables = u16(base + 4);
  if (!numTables) return null;
  let cmapOff = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > len) return null;
    if (u32(rec) === 0x636d6170) {
      cmapOff = u32(rec + 8);
      break;
    }
  }
  if (!cmapOff || cmapOff + 4 > len) return null;
  const nEnc = u16(cmapOff + 2);
  let bestOff = 0;
  let bestScore = -1;
  for (let i = 0; i < nEnc; i++) {
    const rec = cmapOff + 4 + i * 8;
    if (rec + 8 > len) break;
    const plat = u16(rec);
    const enc = u16(rec + 2);
    const sub = cmapOff + u32(rec + 4);
    if (sub + 2 > len) continue;
    const fmt = u16(sub);
    let score = -1;
    if (plat === 3 && enc === 10 && fmt === 12) score = 100;
    else if (plat === 0 && fmt === 12) score = 90;
    else if (plat === 3 && enc === 1 && fmt === 4) score = 80;
    else if (plat === 0 && fmt === 4) score = 70;
    else if (plat === 3 && enc === 1 && fmt === 6) score = 60;
    else if (plat === 0 && fmt === 6) score = 55;
    else if (plat === 3 && enc === 0 && fmt === 4) score = 50;
    else if (plat === 3 && enc === 1 && fmt === 0) score = 40;
    else if (plat === 0 && fmt === 0) score = 35;
    if (score > bestScore) {
      bestScore = score;
      bestOff = sub;
    }
  }
  if (bestScore < 0) return null;
  const fmt = u16(bestOff);
  const raw: [number, number][] = [];

  if (fmt === 12) {
    if (bestOff + 16 > len) return null;
    const n = u32(bestOff + 12);
    for (let i = 0; i < n && raw.length < MAX_RANGES; i++) {
      const g = bestOff + 16 + i * 12;
      if (g + 12 > len) break;
      const s = u32(g);
      const e = u32(g + 4);
      const gid = u32(g + 8);
      if (gid === 0 || s > e) continue; // glyph 0 = .notdef
      raw.push([s, e]);
    }
  } else if (fmt === 4) {
    if (bestOff + 14 > len) return null;
    const segX2 = u16(bestOff + 6);
    const segCount = segX2 / 2;
    if (!segCount) return null;
    const endBase = bestOff + 14;
    const startBase = endBase + segX2 + 2;
    const deltaBase = startBase + segX2;
    const rangeBase = deltaBase + segX2;
    if (rangeBase + segX2 > len) return null;
    for (let seg = 0; seg < segCount; seg++) {
      const end = u16(endBase + seg * 2);
      const start = u16(startBase + seg * 2);
      if (start > end) continue;
      if (start === 0xffff) continue; // 终止段
      const iro = u16(rangeBase + seg * 2);
      if (iro === 0) {
        raw.push([start, end]);
      } else {
        // idRangeOffset != 0：本段字形只能用 glyphIdArray 逐个查，非零才算有字形
        for (let cp = start; cp <= end; cp++) {
          const idx = rangeBase + seg * 2 + iro + (cp - start) * 2;
          if (idx + 2 > len) break;
          if (u16(idx) !== 0) raw.push([cp, cp]);
        }
      }
      if (raw.length > MAX_RANGES) break;
    }
  } else if (fmt === 6) {
    if (bestOff + 10 > len) return null;
    const first = u16(bestOff + 6);
    const count = u16(bestOff + 8);
    for (let i = 0; i < count; i++) {
      const g = bestOff + 10 + i * 2;
      if (g + 2 > len) break;
      if (u16(g) !== 0) raw.push([first + i, first + i]);
    }
  } else if (fmt === 0) {
    if (bestOff + 6 + 256 > len) return null;
    for (let cp = 0; cp < 256; cp++) {
      if (d.getUint8(bestOff + 6 + cp) !== 0) raw.push([cp, cp]);
    }
  } else {
    return null;
  }

  return toCoverage(raw);
}
