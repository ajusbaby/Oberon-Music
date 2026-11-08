// 封面取色：纹理 + 平均色 + 自适应白纱。
// 流光直接用封面位图铺色，取色器只负责页面底色与"洗白"强度。

export interface CoverLook {
  pageRgb: string;
  pageHex: string;
  /** 白纱不透明度：封面越亮洗得越少，纯深色封面最多洗到 0.9。 */
  wash: number;
  /** 72×72 的封面纹理（已 saturate），交给 FlowingLight 铺色。 */
  texture: HTMLCanvasElement | null;
  /** alpha 加权平均色，CSS rgb() 使用逗号格式。 */
  avgCss: string;
  luma: number;
}

const TEX = 72;
const SATURATE = 2.5;

export const FALLBACK_LOOK: CoverLook = {
  pageRgb: "240 238 237",
  pageHex: "#f0eeed",
  wash: 0.72,
  texture: null,
  avgCss: "240,238,237",
  luma: 0.94,
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hexOf(r: number, g: number, b: number): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

/** 图片 → 72×72 纹理 + alpha 加权平均色 + 白纱强度。 */
export function lookFromImage(img: HTMLImageElement): CoverLook {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return FALLBACK_LOOK;
  const cv = document.createElement("canvas");
  cv.width = TEX;
  cv.height = TEX;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return FALLBACK_LOOK;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = "saturate(" + SATURATE + ")";
  ctx.drawImage(img, 0, 0, nw, nh, 0, 0, TEX, TEX);
  ctx.filter = "none";

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, TEX, TEX).data;
  } catch {
    return { ...FALLBACK_LOOK, texture: cv };
  }

  let sr = 0;
  let sg = 0;
  let sb = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 12) continue;
    sr += data[i] * a;
    sg += data[i + 1] * a;
    sb += data[i + 2] * a;
    weight += a;
  }
  if (weight <= 0) return { ...FALLBACK_LOOK, texture: cv };

  const r = sr / weight;
  const g = sg / weight;
  const b = sb / weight;
  // sRGB 感知亮度：线性亮度会把所有中间色压到 0.2 附近，白纱就会一路拉满。
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const wash = clamp((0.82 - luma) / (1 - luma), 0, 0.9);
  const mix = (v: number) => Math.round(v + (255 - v) * wash);

  return {
    pageRgb: mix(r) + " " + mix(g) + " " + mix(b),
    pageHex: hexOf(mix(r), mix(g), mix(b)),
    wash,
    texture: cv,
    avgCss: Math.round(r) + "," + Math.round(g) + "," + Math.round(b),
    luma,
  };
}

const cache = new Map<string, CoverLook>();

function decode(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function sampleCover(url: string | null | undefined): Promise<CoverLook> {
  if (!url) return FALLBACK_LOOK;
  const hit = cache.get(url);
  if (hit) return hit;
  const img = await decode(url);
  if (!img) return FALLBACK_LOOK;
  const look = lookFromImage(img);
  if (cache.size > 24) cache.clear();
  cache.set(url, look);
  return look;
}

/** "#rrggbb" → "r g b"。 */
export function hexToTriple(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return "255 255 255";
  return ((n >> 16) & 255) + " " + ((n >> 8) & 255) + " " + (n & 255);
}
