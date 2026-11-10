// 歌词字体逻辑校验（`npm run check:font`）：纯函数断言，不需要字体文件。
//
// 覆盖《docs/歌词自定义字体系统方案.md》里那些"界面上看不出对错"的规则：
//   ① 六份档案的定义与配置读取容错     ② 字体链装配（主/备/系统/strict、缺资源剔除）
//   ③ 删字体后的引用清理               ④ 覆盖查询二分（§12 缓存的那条快路径）
//   ⑤ 歌曲级与行级语言判定（含简体/繁体/和制汉字/同组翻译行）
//   ⑥ 行内分段（只切 ≥2 个连续拉丁字母；诊断模式再按覆盖切回退段）
import type { FontResource } from "../src/api/types";
import {
  DEFAULT_SIZE,
  DEFAULT_WEIGHT,
  FONT_SOURCE_KEY,
  MATCH_POLICY_KEY,
  PROFILES,
  PROFILES_KEY,
  PROFILE_IDS,
  SIZE_RANGE,
  WEIGHT_OPTIONS,
  applyPolicy,
  buildChain,
  buildStacks,
  defaultProfiles,
  detectLineProfile,
  detectLineProfiles,
  detectSongProfile,
  fontCovers,
  fontFamilyName,
  forgetFont,
  missingSampleChars,
  profileLang,
  readMatchPolicy,
  readProfiles,
  readShowSource,
  readSize,
  readWeight,
  serializeProfiles,
  sharedPolicy,
  splitLineRuns,
} from "../src/lib/lyricFont";
import type { FontProfileId, FontProfile, FontProfiles } from "../src/lib/lyricFont";

/** 造一个只关心少数几个字段的 FontResource fixture */
function mkFont(over: Partial<FontResource> & { id: string }): FontResource {
  const empty = { latin: 0, hanCommon: 0, hanExt: 0, kana: 0, hangul: 0, symbols: 0, emoji: 0 };
  return {
    contentHash: "hash-" + over.id,
    fileName: over.id + ".ttf",
    originalName: over.id + ".ttf",
    byteSize: 100_000,
    faceIndex: 0,
    faces: 1,
    family: over.id,
    subfamily: "Regular",
    postscript: over.id + "-Regular",
    weight: 400,
    width: 5,
    italic: false,
    embedding: "installable",
    variable: false,
    axes: [],
    format: "ttf",
    scripts: [],
    coverage: empty,
    codepoints: 0,
    coverageRanges: [],
    addedAt: 1_700_000_000_000,
    parsed: true,
    warning: null,
    missing: false,
    ...over,
  };
}

const CJK_RANGES: [number, number][] = [
  [0x0020, 0x007e],
  [0x4e00, 0x9fff],
];
const LATIN_ONLY = mkFont({ id: "ephesis", family: "Ephesis", coverageRanges: [[0x0020, 0x007e]] });
const CJK_FONT = mkFont({ id: "mashanzheng", family: "Ma Shan Zheng", coverageRanges: CJK_RANGES });
const BROKEN_FONT = mkFont({ id: "broken", family: "Broken", parsed: false, coverageRanges: [] });

/** 只覆盖到 U+4E10 的中文字体：用来验证"缺字"那段会不会真的标出来 */
const PARTIAL_CJK = mkFont({ id: "partial", family: "Partial CJK", coverageRanges: [[0x4e00, 0x4e10]] });

export function run(): number {
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

  // ---------- 1. 六份档案的定义（§3） ----------
  eq("六份档案，顺序固定", PROFILE_IDS, ["zhHans", "zhHant", "ja", "ko", "latin", "symbols"]);
  eq("简体档案的 lang", profileLang("zhHans"), "zh-Hans");
  eq("繁体档案的 lang", profileLang("zhHant"), "zh-Hant");
  eq("日文档案的 lang", profileLang("ja"), "ja");
  eq("韩文档案的 lang", profileLang("ko"), "ko");
  eq("拉丁档案的 lang", profileLang("latin"), "en");
  ok("每份档案都有标签 / 说明 / 预览句 / 系统链", PROFILE_IDS.every((id) => {
    const p = PROFILES[id];
    return !!p.label && !!p.hint && p.sample.length > 0 && p.system.length > 0;
  }));
  // §11 的预览文案必须带上该语言特有的字形，否则看不出字体压不压得住
  ok("日文预览里有假名", /[\u3041-\u30fa]/.test(PROFILES.ja.sample));
  ok("韩文预览里有谚文", /[\uac00-\ud7a3]/.test(PROFILES.ko.sample));
  ok("繁体预览里有繁体专用字", /[繁體音樂這是]/.test(PROFILES.zhHant.sample));
  ok("符号预览里有符号和 Emoji", /[♫★→①]/.test(PROFILES.symbols.sample) && /[\u{1F300}-\u{1FAFF}]/u.test(PROFILES.symbols.sample));

  // ---------- 2. 用户配置的读取（容错优先：坏数据不许把界面搞崩） ----------
  eq("没有配置时六份都是默认值", readProfiles({}), defaultProfiles());
  eq("JSON 坏掉退回默认", readProfiles({ [PROFILES_KEY]: "{not json" }), defaultProfiles());
  eq("值不是对象也退回默认", readProfiles({ [PROFILES_KEY]: "42" }), defaultProfiles());
  const parsed = readProfiles({
    [PROFILES_KEY]: JSON.stringify({
      ja: { primaryFontId: "mashanzheng", fallbackFontIds: ["ephesis", 7], fallbackPolicy: "strict", enabled: false },
      ko: { fallbackPolicy: "nonsense" },
    }),
  });
  eq("只写了 ja：其它档案仍为默认", parsed.zhHans, defaultProfiles().zhHans);
  eq("ja 的主字体", parsed.ja.primaryFontId, "mashanzheng");
  eq("fallbackFontIds 里的非字符串被剔除", parsed.ja.fallbackFontIds, ["ephesis"]);
  eq("ja 的策略", parsed.ja.fallbackPolicy, "strict");
  eq("ja 的 enabled", parsed.ja.enabled, false);
  eq("未知策略退回 same-language", parsed.ko.fallbackPolicy, "same-language");
  eq("序列化后可原样读回", readProfiles({ [PROFILES_KEY]: serializeProfiles(parsed) }), parsed);

  // ---------- 3. 字体链装配（§7.1） ----------
  // 家族名里带空格的必须加引号写进 font-family，所以断言里也按带引号的样子比
  const q = (name: string) => '"' + name + '"';
  const defs = defaultProfiles();
  const sysOnly = buildStacks(defs, []);
  eq("没有导入字体时，简体链首项是雅黑", sysOnly.zhHans.families[0], q("Microsoft YaHei"));
  eq("没有导入字体时，日文链首项是 Yu Gothic UI", sysOnly.ja.families[0], q("Yu Gothic UI"));
  ok("每条链都以 sans-serif 收尾", PROFILE_IDS.every((id) => sysOnly[id].families[sysOnly[id].families.length - 1] === "sans-serif"));
  ok("没有导入字体时链里没有用户字体", PROFILE_IDS.every((id) => sysOnly[id].userFontIds.length === 0));

  const zhPrimary: FontProfiles = { ...defs, zhHans: { ...defs.zhHans, primaryFontId: "mashanzheng" } };
  const zhChain = buildChain("zhHans", zhPrimary.zhHans, [CJK_FONT, LATIN_ONLY]);
  eq("主字体排在系统链之前", zhChain.families[0], '"OB mashanzheng"');
  eq("主字体之后紧跟该系统链的首项", zhChain.families[1], q("Microsoft YaHei"));
  ok("userFontIds 只记真正进了链的字体", zhChain.userFontIds.length === 1 && zhChain.userFontIds[0] === "mashanzheng");

  const withFb: FontProfile = { ...zhPrimary.zhHans, fallbackFontIds: ["ephesis"] };
  const fbChain = buildChain("zhHans", withFb, [CJK_FONT, LATIN_ONLY]);
  eq("备用字体排在主字体之后", fbChain.families.slice(0, 2), ['"OB mashanzheng"', '"OB ephesis"']);

  const sysFirst: FontProfile = { ...withFb, fallbackPolicy: "system-first" };
  const sysFirstChain = buildChain("zhHans", sysFirst, [CJK_FONT, LATIN_ONLY]);
  eq("系统优先后，系统链先走", sysFirstChain.families[0], q("Microsoft YaHei"));
  ok("系统优先时用户字体仍在链里（只是靠后）",
    sysFirstChain.families.indexOf('"OB mashanzheng"') > sysFirstChain.families.indexOf("SimSun"));

  const strictChain = buildChain("zhHans", { ...withFb, fallbackPolicy: "strict" }, [CJK_FONT, LATIN_ONLY]);
  eq("严格模式只留导入字体 + sans-serif", strictChain.families, ['"OB mashanzheng"', '"OB ephesis"', "sans-serif"]);

  // 资源被删 / 标记 missing：链必须自动回落，不能留一个查不到的族名
  const ghosts = buildChain("zhHans", { ...withFb, primaryFontId: "ghost" }, [CJK_FONT]);
  ok("查不到的主字体被剔除，链回落到系统字体",
    ghosts.families[0] === q("Microsoft YaHei") && !ghosts.families.some((f) => f.includes("ghost")));
  const missingRes = buildChain("zhHans", { ...withFb, primaryFontId: "gone" }, [mkFont({ id: "gone", missing: true })]);
  ok("磁盘上已消失的字体不进链",
    missingRes.families[0] === q("Microsoft YaHei") && missingRes.userFontIds.length === 0);

  const disabled = buildChain("zhHans", { ...withFb, enabled: false }, [CJK_FONT, LATIN_ONLY]);
  ok("档案关闭时等价于只用系统字体", disabled.families[0] === q("Microsoft YaHei"));

  // 中文字体绝不能被塞进日文链（旧方案最典型的错误）
  const jaSys = buildChain("ja", defaultProfiles().ja, [CJK_FONT]).families;
  ok("日文链从日文字体开始", jaSys[0] === q("Yu Gothic UI"));
  // "同语言回退"的底线：中文系统字体根本不该出现在日文链里
  ok("日文链里没有中文系统字体", !jaSys.some((fam) => /YaHei|PingFang SC|SimSun|Hiragino Sans GB/.test(fam)));
  eq("字体族名带命名空间前缀", fontFamilyName("abc"), "OB abc");

  // ---------- 4. 删字体后的引用清理（§16） ----------
  const before: FontProfiles = {
    ...defs,
    zhHans: { ...defs.zhHans, primaryFontId: "mashanzheng", fallbackFontIds: ["ephesis"] },
    ja: { ...defs.ja, fallbackFontIds: ["mashanzheng"] },
  };
  const after = forgetFont(before, "mashanzheng");
  eq("主字体被删 → 回到系统字体", after.profiles.zhHans.primaryFontId, null);
  eq("备用字体里的同名引用一并清掉", after.profiles.ja.fallbackFontIds, []);
  eq("受影响的档案被列出", after.touched.sort(), ["ja", "zhHans"]);
  eq("没引用的档案不受影响", after.profiles.ko, before.ko);

  // ---------- 5. 缺字策略是"一行改全部" ----------
  eq("默认六份一致", sharedPolicy(defs), "same-language");
  eq("整体改策略", PROFILE_IDS.every((id) => applyPolicy(defs, "strict")[id].fallbackPolicy === "strict"), true);
  const mixed: FontProfiles = { ...defs, ja: { ...defs.ja, fallbackPolicy: "strict" } };
  eq("不一致时界面显示默认档", sharedPolicy(mixed), "same-language");

  // ---------- 6. 覆盖查询（§12 的二分，播放时每帧都会走） ----------
  const ranges = [[0x41, 0x5a], [0x4e00, 0x9fff], [0x1f300, 0x1f5ff]] as [number, number][];
  const cover = mkFont({ id: "cover", coverageRanges: ranges });
  eq("区间起点", fontCovers(cover, 0x41), true);
  eq("区间终点", fontCovers(cover, 0x5a), true);
  eq("区间后一位", fontCovers(cover, 0x5b), false);
  eq("区间前一位", fontCovers(cover, 0x40), false);
  eq("中间那个区间", fontCovers(cover, 0x5000), true);
  eq("末区间起点", fontCovers(cover, 0x1f300), true);
  eq("末区间外", fontCovers(cover, 0x1f600), false);
  eq("未解析的字体一律当作没覆盖", fontCovers(BROKEN_FONT, 0x41), false);
  eq("没有字体时安全返回 false", fontCovers(null, 0x41), false);
  eq("空区间表不匹配任何码点", fontCovers(mkFont({ id: "none" }), 0x41), false);

  // ---------- 7. 预览缺字提示（§11） ----------
  const missingJa = missingSampleChars("ja", LATIN_ONLY);
  ok("只有拉丁的字体，日文预览里几乎每个字都缺", missingJa.length >= 8);
  // 全字库样本只覆盖基本区：预览里缺的是三个全角标点 + 两个扩展区生僻字
  const missingZh = missingSampleChars("zhHans", CJK_FONT);
  eq("全字库字体在简体预览里只缺全角标点与扩展区生僻字", missingZh.length, 5);
  ok("缺字列表里确实有扩展区生僻字", missingZh.includes("𠀀") && missingZh.includes("𪚥"));
  ok("缺字列表不含重复", new Set(missingSampleChars("zhHans", LATIN_ONLY)).size === missingSampleChars("zhHans", LATIN_ONLY).length);
  eq("没有主字体时不报缺字", missingSampleChars("zhHans", null), []);
  eq("不能解析的字体不报缺字", missingSampleChars("zhHans", BROKEN_FONT), []);

  // ---------- 8. 歌曲级判定（§5.4） ----------
  eq("简体歌词 → 简体中文", detectSongProfile(["我们都在奔跑", "时间不会等谁"]), "zhHans");
  eq("日文歌词（假名多）→ 日文", detectSongProfile(["君の名前を呼ぶよ", "東京の夜"]), "ja");
  eq("韩文歌词 → 韩文", detectSongProfile(["너의 이름은", "음악을 들어요"]), "ko");
  eq("繁体歌词 → 繁体中文", detectSongProfile(["我們這樣的人", "這就是答案"]), "zhHant");
  eq("英文歌词 → 拉丁", detectSongProfile(["Hello darkness my old friend"]), "latin");
  eq("纯符号 → 符号档案", detectSongProfile(["♫ ♫ ★"]), "symbols");
  eq("空歌词 → 符号档案（不硬套某种语言）", detectSongProfile([]), "symbols");
  // 汉字为主但夹着假名：日文 —— 中日共用汉字区，必须靠假名定音
  eq("少量假名也足以判成日文", detectSongProfile(["東京の街を歩いて", "君と僕の距離", "夜が明ける"]), "ja");
  // 全汉字但满是日式汉字（无假名）：仍应判成日文
  eq("全是日式汉字也能判成日文", detectSongProfile(["駅前の風景", "円を描く", "沢山の働く人"]), "ja");
  // 只有汉字、没有简繁差异标记：默认简体（不按 Unicode 区间猜）
  eq("普通汉字歌词默认简体", detectSongProfile(["春风十里", "不如你"]), "zhHans");

  // ---------- 9. 行级判定（§5.3 的证据权重） ----------
  eq("假名行 → 日文", detectLineProfile("君の名前を呼ぶ", "zhHans"), "ja");
  eq("谚文行 → 韩文", detectLineProfile("너의 이름은", "zhHans"), "ko");
  eq("中文歌里的英文行 → 拉丁", detectLineProfile("Hello darkness", "zhHans"), "latin");
  eq("中文歌里的符号行 → 符号档案", detectLineProfile("♫ ♫ ★", "zhHans"), "symbols");
  eq("空行跟随歌曲", detectLineProfile("   ", "ja"), "ja");
  eq("汉字行跟歌曲走（consistency 优先）", detectLineProfile("我们的时光", "zhHans", "consistent"), "zhHans");
  // 同一行汉字，整首一致时不该因为冒出一个繁体字就换字体
  eq("一致策略下繁体字不抢行", detectLineProfile("我們都在奔跑", "zhHans", "consistent"), "zhHans");
  eq("逐行判定下繁体字夺回行归属", detectLineProfile("我們都是這樣的人", "zhHans", "accurate"), "zhHant");
  eq("逐行判定下简体字落到简体", detectLineProfile("我们这样说话", "zhHant", "accurate"), "zhHans");
  // 汉字 + 大量假名：假名 出现即定音
  eq("汉字里夹假名 → 日文", detectLineProfile("東京の街を歩いて", "zhHans", "accurate"), "ja");
  // 回归：日文歌里带中文翻译，纯汉字行绝不能被判成日文（否则中文字幕挂日文字体）
  eq(
    "日文歌里的纯汉字翻译行（整首一致）→ 简体中文",
    detectLineProfile("你的名字", "ja", "consistent"),
    "zhHans",
  );
  eq(
    "韩文歌里的纯汉字翻译行（整首一致）→ 简体中文",
    detectLineProfile("有你的地方我会与你同在", "ko", "consistent"),
    "zhHans",
  );
  eq(
    "逐行判定下日文歌的纯汉字行跟随日文",
    detectLineProfile("你的名字", "ja", "accurate"),
    "ja",
  );
  // 汉字夹拉丁单词：汉字定档，拉丁段由 splitLineRuns 再切
  eq("汉字夹拉丁 → 中文档案", detectLineProfile("我们 OK 的", "latin", "consistent"), "zhHans");
  // 日式汉字是硬证据，两种策略下都判日文
  eq("日式汉字（円 駅）任何时候都判日文", detectLineProfile("駅前の円", "zhHans", "consistent"), "ja");

  // ---------- 10. 同组翻译行跟随（§5.4 组内一致） ----------
  const groupTexts = ["君の名前を呼ぶ", "你的名字", "Hello"];
  const grouped = detectLineProfiles(groupTexts, "zhHans", "accurate", [[0, 1]]);
  eq("同组里有一行日文，整组跟日文", grouped.slice(0, 2), ["ja", "ja"]);
  eq("组外不受影响", grouped[2], "latin");
  const consistentGroup = detectLineProfiles(groupTexts, "zhHans", "consistent", [[0, 1]]);
  eq("整首一致策略下不做组内传播", consistentGroup, ["ja", "zhHans", "latin"]);

  // ---------- 11. 行内分段（§6.2） ----------
  const noPrimary = () => null;
  const plain = splitLineRuns("我们都在奔跑", "zhHans", noPrimary);
  eq("纯中文行只有一段", plain.length, 1);
  eq("纯中文行的档案", plain[0].profile, "zhHans");

  const mix = splitLineRuns("这是 OK 的", "zhHans", noPrimary);
  eq("中文夹英文切成三段", mix.map((r) => r.profile), ["zhHans", "latin", "zhHans"]);
  eq("切出来的英文段内容", mix[1].text, "OK");
  eq("拼回去必须等于原文", mix.map((r) => r.text).join(""), "这是 OK 的");

  const single = splitLineRuns("我爱B站", "zhHans", noPrimary);
  eq("单个字母不切（B站 不该被劈开）", single.length, 1);

  const latinLine = splitLineRuns("Hello, world", "latin", noPrimary);
  eq("拉丁行整行留在拉丁档案", latinLine.map((r) => r.profile), ["latin"]);

  const koLine = splitLineRuns("너의 이름은 Baby 좋아", "ko", noPrimary);
  eq("韩文行里的英文单词切到拉丁", koLine.map((r) => r.profile), ["ko", "latin", "ko"]);
  eq("韩文行切分后拼回原文", koLine.map((r) => r.text).join(""), "너의 이름은 Baby 좋아");

  const numberLine = splitLineRuns("2024 年", "zhHans", noPrimary);
  eq("纯数字不单独成段（没有字母）", numberLine.length, 1);

  // 诊断模式：主字体没覆盖的字单独成段，并标 fallback
  const byCov = splitLineRuns("永永永", "zhHans", () => PARTIAL_CJK, true);
  eq("主字体缺的字被切成回退段", byCov.length, 1);
  eq("回退段被标记", byCov[0].fallback, true);
  const coveredRun = splitLineRuns("丁丁丁", "zhHans", () => PARTIAL_CJK, true);
  eq("主字体覆盖的字不标回退", coveredRun[0].fallback, false);
  const half = splitLineRuns("丁丁永", "zhHans", () => PARTIAL_CJK, true);
  eq("同一行里的覆盖段与回退段分开", half.map((r) => r.fallback), [false, true]);
  eq("按覆盖切分的段落拼回原文", half.map((r) => r.text).join(""), "丁丁永");
  const noParse = splitLineRuns("永永永", "zhHans", () => BROKEN_FONT, true);
  eq("字体解析失败时不做覆盖切分（不许凭空标回退）", noParse[0].fallback, false);

  // 段落数要有上限意识：一行几十段会让 background-clip 的逐句扫过变慢
  ok("普通歌词行的段数不会失控", splitLineRuns("我们 Hello 都是 2024 的 Music 爱好者", "zhHans", noPrimary).length <= 8);

  // ---------- 12. 其余设置读取（沿用旧键） ----------
  eq("默认字号", readSize({}), DEFAULT_SIZE);
  eq("字号区间下限", readSize({ lyricFontSize: "0.1" }), SIZE_RANGE[0]);
  eq("字号区间上限", readSize({ lyricFontSize: "9" }), SIZE_RANGE[1]);
  eq("字号非法值退回默认", readSize({ lyricFontSize: "abc" }), DEFAULT_SIZE);
  eq("默认粗细", readWeight({}), DEFAULT_WEIGHT);
  eq("粗细按存的值", readWeight({ lyricFontWeight: "400" }), 400);
  ok("粗细选项含 300/400/500/700", [300, 400, 500, 700].every((w) => WEIGHT_OPTIONS.includes(w)));
  eq("来源标注默认开启（§11）", readShowSource({}), true);
  eq("来源标注可以关掉", readShowSource({ [FONT_SOURCE_KEY]: "0" }), false);
  eq("语言匹配默认整首一致", readMatchPolicy({}), "consistent");
  eq("语言匹配可以改成逐行", readMatchPolicy({ [MATCH_POLICY_KEY]: "accurate" }), "accurate");

  // ---------- 13. 实际链长一眼可见（人工检查用） ----------
  console.log("\n--- 实际字体链（前 5 个 family）---");
  const withFonts = buildStacks({ ...defs, zhHans: { ...defs.zhHans, primaryFontId: "mashanzheng" } }, [CJK_FONT]);
  for (const id of PROFILE_IDS) {
    const fams = withFonts[id].families.slice(0, 5).join(" | ");
    console.log("  " + PROFILES[id].label.padEnd(6, "　") + ": " + fams);
  }

  console.log("\n结果：通过 " + pass + " / 失败 " + fail);
  return fail;
}

// 让 tsc 知道这些类型确实被用到了（避免 noUnusedLocals 报未使用的 import）
void (null as FontProfile | FontProfileId | null);
