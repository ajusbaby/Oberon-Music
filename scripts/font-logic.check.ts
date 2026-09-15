// 歌词字体逻辑校验（`npm run check:font`）：拿真字体文件验 cmap 解析，再验语言判定与字体栈的三条规则。
// 字体字节由外部 runner 通过 globalThis.__FONTS__ 注入（本文件不直接碰 node API，避免污染 tsc）。
import { covers, parseCmap } from "../src/lib/fontCoverage";
import {
  SYSTEM_FONT,
  detectLineSlot,
  detectLineSlots,
  detectSongSlot,
  familyOf,
  fontStackFor,
  lineHasMissing,
  sampleCoverage,
} from "../src/lib/lyricFont";

export function run(): number {
  const F = (globalThis as unknown as { __FONTS__: Record<string, ArrayBuffer> }).__FONTS__;
  let pass = 0;
  let fail = 0;
  const eq = (label: string, got: unknown, want: unknown) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) pass++;
    else {
      fail++;
      console.log("FAIL " + label + "  got=" + g + "  want=" + w);
    }
  };
  const ok = (label: string, cond: boolean) => eq(label, cond, true);

  // ---------- 1. cmap 解析（真字体）----------
  const ep = parseCmap(F.ephesis);
  const ms = parseCmap(F.mashan);
  ok("Ephesis 能解析", !!ep);
  ok("MaShanZheng 能解析", !!ms);
  if (ep) {
    ok("Ephesis 有 A", covers(ep, 0x41));
    ok("Ephesis 没有「说」", !covers(ep, 0x8bf4));
    console.log("  Ephesis 覆盖码位 " + ep.count);
  }
  if (ms) {
    ok("马善政 有「说」", covers(ms, 0x8bf4));
    ok("马善政 有「山」", covers(ms, 0x5c71));
    console.log("  马善政 覆盖码位 " + ms.count);
    const sc = sampleCoverage("zh", ms);
    eq("马善政 中文样张无缺字", sc && sc.missing.length, 0);
  }
  if (ep) {
    const sc = sampleCoverage("zh", ep);
    ok("Ephesis 中文样张大量缺字", !!sc && sc.missing.length >= 5);
    console.log("  Ephesis 缺的中文样字：" + (sc ? sc.missing.join("") : ""));
    ok("Ephesis 对「说」判定缺字", lineHasMissing("说这们", "zh", ep));
    ok("未检测(null) 永不判定缺字", !lineHasMissing("说这们", "zh", null));
  }

  // ---------- 2. 语言判定 ----------
  const jpSong = ["君の名は", "你的名字", "夜に駆ける", "夜跑"];
  eq("日文歌（带中文翻译）主语言 = ja", detectSongSlot(jpSong), "ja");
  eq("韩文歌主语言 = ko", detectSongSlot(["사랑해요", "I love you"]), "ko");
  eq("中文歌主语言 = zh", detectSongSlot(["山有木兮木有枝", "心悦君兮君不知"]), "zh");
  eq("纯英文歌主语言 = latin", detectSongSlot(["All that glitters", "is not gold"]), "latin");

  eq("含假名的行 → ja", detectLineSlot("君の名は", "ja"), "ja");
  eq("中文翻译行（有假名兄弟）→ zh", detectLineSlot("你的名字", "ja", ["君の名は"]), "zh");
  eq("中文翻译行（含简体特征字）→ zh", detectLineSlot("说过的话", "ja", []), "zh");
  eq("纯汉字日文原词行 → 跟随整首 = ja", detectLineSlot("夢の中", "ja", []), "ja");
  eq("和制汉字行 → ja", detectLineSlot("円駅沢", "zh", []), "ja");
  eq("中文歌里的纯汉字行 → zh", detectLineSlot("山有木兮", "zh", []), "zh");

  // ---- 韩文歌：中文翻译行（用户报的问题）----
  const krSong = ["사랑해요", "愛情這種東西", "그대여"];
  eq("韩文歌主语言 = ko", detectSongSlot(krSong), "ko");
  eq("韩文原词行 → ko", detectLineSlot("사랑해요", "ko", ["愛情這種東西"]), "ko");
  eq(
    "繁体中文翻译行（兄弟是谚文）→ zh（修前会落到 ko，被韩文字体抢走）",
    detectLineSlot("愛情這種東西", "ko", ["사랑해요"]),
    "zh"
  );
  eq("繁体翻译行（无兄弟）也靠繁体特征字判 zh", detectLineSlot("這種東西", "ko", []), "zh");
  eq(
    "按组判定：韩文原词 ko / 中文翻译 zh",
    detectLineSlots(["사랑해요", "愛情這種東西"], "ko", [[0, 1]]),
    ["ko", "zh"]
  );
  eq("韩文歌里的英文行 → latin", detectLineSlot("I love you", "ko", ["사랑해요"]), "latin");
  eq("纯汉字日文行（无假名兄弟）仍是 ja，不能回归", detectLineSlot("東京", "ja", []), "ja");

  const groups = [[0, 1]];
  const slots = detectLineSlots(["君の名は", "你的名字"], "ja", groups);
  eq("按组判定：原词 ja / 翻译 zh", slots, ["ja", "zh"]);
  const slots2 = detectLineSlots(["夢", "空"], "ja", [[0], [1]]);
  eq("无假名无证据时跟随整首", slots2, ["ja", "ja"]);
  // 已知边界：整首歌词一个假名都没有的日文歌，码位层面无从分辨 → 会被判成中文歌。
  // 这是"汉字共用码位"的硬限制，兜底手段是用户显式设置日文槽（字体在每个槽都能选）。
  eq("边界：零假名的日文歌词会被判成中文", detectSongSlot(["夢", "空", "永遠"]), "zh");

  // ---------- 3. 字体栈：汉字不外借 ----------
  const zhFont = "file:zh.ttf";
  const jaFont = "file:ja.ttf";
  const latinFont = "file:latin.ttf";
  const bare = (id: string) => familyOf(id).replace(/"/g, "");
  const ownFam = (id: string, slot: string) => '"' + bare(id) + "__" + slot + '"';
  const zhFam = familyOf(zhFont);
  const chosen = { latin: "", zh: zhFont, ja: "", ko: "" };
  const sJa = fontStackFor(chosen, "ja", "ja");
  ok("① 日文行不会拿到中文字体（用户报的那个问题）", !sJa.includes(zhFam));
  ok("① 日文行落到系统兜底链", sJa.includes("Yu Gothic UI"));
  const sZh = fontStackFor(chosen, "zh", "zh");
  ok("中文行仍然用中文字体", sZh.includes(ownFam(zhFont, "zh")));
  ok("中文行有补缺层（不限范围那份）", sZh.includes(familyOf(zhFont)));
  const sLat = fontStackFor(chosen, "latin", "zh");
  ok("中文槽的**受限**字面（__zh）不会出现在别的语言的行上", !sLat.includes(ownFam(zhFont, "zh")));
  ok(
    "英文行走「跟随歌曲主语言」的补缺层（不限范围那份，这是设计如此）",
    sLat.includes(familyOf(zhFont))
  );
  const sKo = fontStackFor(chosen, "ko", "zh");
  ok("韩文行同样拿不到中文槽的受限字面", !sKo.includes(ownFam(zhFont, "zh")));
  ok("韩文行含谚文系统正体（Malgun Gothic）", sKo.includes("Malgun Gothic"));

  const both = { latin: latinFont, zh: zhFont, ja: jaFont, ko: "" };
  const sJa2 = fontStackFor(both, "ja", "ja");
  ok("日文行用日文字体", sJa2.includes(ownFam(jaFont, "ja")));
  ok("日文行仍不含中文字体", !sJa2.includes(bare(zhFont)));
  const sJa3 = fontStackFor(both, "ja", "ja", true);
  ok("整行回退：撤掉日文字体本体", !sJa3.includes(familyOf(jaFont)));
  ok("整行回退：借出的西文仍保留", sJa3.includes(bare(latinFont)));
  const sKo2 = fontStackFor(both, "ko", "ko");
  ok("韩文行能拿到西文槽借出的拉丁", sKo2.includes(bare(latinFont)));
  const sysOnly = fontStackFor({ latin: "", zh: SYSTEM_FONT, ja: "", ko: "" }, "zh", "zh");
  ok("显式「系统默认」不再被主语言字体接管", !sysOnly.includes("LyricUser"));

  console.log("\n--- 实际字体栈（前 4 个 family）---");
  const head = (label: string, s: string) => console.log("  " + label + ": " + s.split(", ").slice(0, 4).join(" | "));
  head("日文行(仅中文槽有字体)", sJa);
  head("中文行", sZh);
  head("英文行(仅中文槽有字体)", sLat);
  head("日文行(中日都有字体)", sJa2);
  head("日文行(整行回退)", sJa3);
  console.log("\n结果：通过 " + pass + " / 失败 " + fail);
  return fail;
}