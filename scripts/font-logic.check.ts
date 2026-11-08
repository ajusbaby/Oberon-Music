// 歌词字体逻辑校验（`npm run check:font`）：纯函数断言，不需要字体文件。
// 覆盖：① 设置读取与槽定义 ② 语言判定（假名/谚文/简体特征字/和制汉字/同组翻译行）
//       ③ 字体栈（每种语言只拿自己的系统链）④ 系统兜底链顺序
// 之所以要有它：这些规则在界面上很难一眼看出对错（"日文行被中文字体接管"就是这么漏过去的）。
import {
  DEFAULT_SIZE,
  DEFAULT_WEIGHT,
  SIZE_RANGE,
  SLOT_IDS,
  WEIGHT_OPTIONS,
  detectLineSlot,
  detectLineSlots,
  detectSongSlot,
  fontStackFor,
  lyricFontStacks,
  readMatchPolicy,
  readSize,
  readWeight,
  slotLang,
  systemChainFor,
} from "../src/lib/lyricFont";

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

  // ---------- 1. 槽定义与设置读取 ----------
  eq("四个语言槽，顺序固定", SLOT_IDS, ["latin", "zh", "ja", "ko"]);
  eq("中文槽的 lang", slotLang("zh"), "zh-Hans");
  eq("日文槽的 lang", slotLang("ja"), "ja");
  eq("字号默认值", readSize({}), DEFAULT_SIZE);
  eq("字号越界收回到下限", readSize({ lyricFontSize: "0.1" }), SIZE_RANGE[0]);
  eq("字号越界收回到上限", readSize({ lyricFontSize: "99" }), SIZE_RANGE[1]);
  eq("字号非法值回落默认", readSize({ lyricFontSize: "abc" }), DEFAULT_SIZE);
  eq("字重默认值", readWeight({}), DEFAULT_WEIGHT);
  eq("字重小于 100 回落默认", readWeight({ lyricFontWeight: "5" }), DEFAULT_WEIGHT);
  eq("字重超过 900 收回到上限", readWeight({ lyricFontWeight: "950" }), 900);
  eq("字重越界收回到上限", readWeight({ lyricFontWeight: "5000" }), 900);
  eq("语言匹配默认一致性优先", readMatchPolicy({}), "consistent");
  eq("语言匹配识别准确优先", readMatchPolicy({ lyricFontMatch: "accurate" }), "accurate");
  eq("语言匹配非法值回落默认", readMatchPolicy({ lyricFontMatch: "x" }), "consistent");
  ok("字重选项非空", WEIGHT_OPTIONS.length > 0);

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

  // ---- 假名符号与密度：中文歌不该因为「・」「ー」或夹了一句日文就被整首判成日文 ----
  // 旧实现：RE_KANA 把 U+30FB/U+30FC 也算假名，且 detectSongSlot 出现即判定。
  // 结果一首中文歌只要有一个「・」，整首走日文字体栈 → 纯汉字行全被 Yu Gothic 接管。
  eq("中点「・」不算假名", detectLineSlot("A・B", "zh", []), "latin");
  eq("长音「ー」不算假名", detectLineSlot("好ーー好", "zh", []), "zh");
  eq("中文歌夹中点 → 仍是中文", detectSongSlot(["A・B 的夜晚", "月亮会一直带领"]), "zh");
  eq("中文歌夹长音 → 仍是中文", detectSongSlot(["好ーー好", "月亮会一直带领"]), "zh");
  eq("中文歌夹一句日文 → 仍是中文", detectSongSlot(["君の名は", "月亮会一直带领", "山有木兮木有枝"]), "zh");
  eq("日文歌假名密度高 → ja", detectSongSlot(["君の名は", "夜に駆ける"]), "ja");
  eq("简体特征字让中文行脱离日文主语言", detectLineSlot("月亮会一直带领", "ja", []), "zh");

// 《红蔷薇白玫瑰》：结尾一句「사랑해 사랑해」曾让整首判成 ko，44/75 行走了韩文字体。
// Malgun Gothic 的汉字字面比雅黑小一成，「己」「口」「至」还要更矮 → 行内大小粗细不一致。
eq(
  "中文歌夹一句韩语 → 仍是中文",
  detectSongSlot([
    "사랑해 사랑해",
    "说不出说不出一句话",
    "也看到天真的自己",
    "月亮会一直带领",
    "往幸福的路径",
    "梦里鲜红的蔷薇",
  ]),
  "zh"
);
eq("含谚文的那一行自己仍是 ko（韩文字体）", detectLineSlot("사랑해 사랑해", "zh", []), "ko");
eq("繁体特征字让韩文歌里的汉字行判 zh，不跟随 ko", detectLineSlot("愛情這種東西", "ko", []), "zh");

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
  eq("纯汉字日文行：默认一致性优先 → zh", detectLineSlot("東京", "ja", []), "zh");

  const groups = [[0, 1]];
  const slots = detectLineSlots(["君の名は", "你的名字"], "ja", groups);
  eq("按组判定：原词 ja / 翻译 zh", slots, ["ja", "zh"]);
  const slots2 = detectLineSlots(["夢", "空"], "ja", [[0], [1]], "accurate");
  eq("准确优先：无假名无证据时跟随整首", slots2, ["ja", "ja"]);
  // 已知边界：整首歌词一个假名都没有的日文歌，码位层面无从分辨 → 会被判成中文歌。
  // 这是"汉字共用码位"的硬限制，兜底手段是用户显式设置日文槽（字体在每个槽都能选）。
  eq("边界：零假名的日文歌词会被判成中文", detectSongSlot(["夢", "空", "永遠"]), "zh");

  // ---- 语言匹配策略：纯汉字行默认不跟随主语言（P0）----
  // 背景：汉字是中日韩共用码位，纯汉字行从码位看不出语种。跟随主语言意味着
  // 「一首中文歌里有了一句外语，全篇汉字都换字体」——《红蔷薇白玫瑰》就是这么坏的。
  eq("一致性优先：ko 主语言下的纯汉字行 → zh", detectLineSlot("東京", "ko", []), "zh");
  eq("一致性优先：ja 主语言下的纯汉字行 → zh", detectLineSlot("東京", "ja", []), "zh");
  eq("准确优先：ko 主语言下的纯汉字行 → ko", detectLineSlot("東京", "ko", [], "accurate"), "ko");
  eq("准确优先：ja 主语言下的纯汉字行 → ja", detectLineSlot("東京", "ja", [], "accurate"), "ja");
  // 硬证据仍然优先于策略：和制汉字 / 简繁专用字 / 兄弟行 都先给出结论
  eq("准确优先下和制汉字仍判 ja", detectLineSlot("円駅沢", "zh", [], "accurate"), "ja");
  eq("一致性优先下简体专用字仍判 zh", detectLineSlot("说过的话", "ja", []), "zh");
  eq("兄弟行证据优先于策略（韩文歌的纯汉字翻译行）", detectLineSlot("東京", "ko", ["사랑해"]), "zh");
  eq("兄弟行证据优先于策略（准确优先也一样）", detectLineSlot("東京", "ko", ["사랑해"], "accurate"), "zh");
  eq("detectLineSlots 默认走一致性优先", detectLineSlots(["東京"], "ja", undefined), ["zh"]);
  eq("detectLineSlots 准确优先", detectLineSlots(["東京"], "ja", undefined, "accurate"), ["ja"]);
  // 《红蔷薇白玫瑰》回归：主语言修好之后，纯汉字行也不能再被韩文主语言带走
  eq("红蔷薇白玫瑰：ko 主语言 + 纯汉字行 → zh", detectLineSlot("也看到天真的自己", "ko", []), "zh");


  // ---------- 3. 字体栈：每种语言只拿自己的系统链 ----------
  // 自定义字体已移除，栈里只剩系统字体；这里守的是"别把别的语言的系统正体串进来"。
  const YAHEI = '"Microsoft YaHei"';
  const YUGOTH = '"Yu Gothic UI"';
  const MALGUN = '"Malgun Gothic"';
  const sZh = fontStackFor("zh");
  const sJa = fontStackFor("ja");
  const sKo = fontStackFor("ko");
  const sLat = fontStackFor("latin");
  ok("中文行用中文正体", sZh.includes(YAHEI));
  ok("日文行用日文正体", sJa.includes(YUGOTH));
  ok("韩文行用韩文正体", sKo.includes(MALGUN));
  // 每行都会在末尾挂上四种语言的正体做逐字兜底，但**首选的 CJK 正体**必须是自己那一款。
  const firstCjk = (s: string) => {
    const fams = s.split(", ").map((x) => x.trim());
    return fams.find((f) => f === YAHEI || f === YUGOTH || f === MALGUN || f === "Meiryo" || f === "SimSun");
  };
  eq("中文行：第一个 CJK 系统字体是中文正体", firstCjk(sZh), YAHEI);
  eq("日文行：第一个 CJK 系统字体是日文正体", firstCjk(sJa), YUGOTH);
  eq("韩文行：第一个 CJK 系统字体是韩文正体", firstCjk(sKo), MALGUN);
  eq("西文行：汉字兜底按中文处理（界面语言是中文，不能落进日文正体）", firstCjk(sLat), YAHEI);
  ok("每条栈都以通用族收尾", sZh.endsWith("sans-serif") && sJa.endsWith("sans-serif") && sKo.endsWith("sans-serif") && sLat.endsWith("sans-serif"));

  // ---------- 3b. lyricFontStacks：按主语言取 primary ----------
  const none = lyricFontStacks(null);
  eq("无主语言时 primary = 西文栈", none.primary, none.bySlot.latin);
  const jaSong = lyricFontStacks("ja");
  eq("日文歌 primary = 日文栈", jaSong.primary, jaSong.bySlot.ja);
  eq("四个槽都有字体栈", Object.keys(jaSong.bySlot).sort(), ["ja", "ko", "latin", "zh"]);
  ok("每槽都是非空字符串", SLOT_IDS.every((k) => jaSong.bySlot[k].length > 0));

  // ---------- 4. 系统兜底链：按语言分 ----------
  // 四种语言共用一条链时，日文正体（Yu Gothic UI）会抢在中文正体前面接走大部分汉字，
  // 简体专用字（说/过/话/这/们/时/间/爱/难…）再落到雅黑 → 一行中文被劈成两三种字体。
  const zhChain = systemChainFor("zh");
  const jaChain = systemChainFor("ja");
  const koChain = systemChainFor("ko");
  const at = (chain: string[], fam: string) => chain.indexOf(fam);
  ok("中文链：中文正体在日文正体之前", at(zhChain, YAHEI) >= 0 && at(zhChain, YAHEI) < at(zhChain, YUGOTH));
  ok("中文链：中文正体在韩文正体之前", at(zhChain, YAHEI) < at(zhChain, MALGUN));
  ok("日文链：日文正体在中文正体之前", at(jaChain, YUGOTH) >= 0 && at(jaChain, YUGOTH) < at(jaChain, YAHEI));
  ok("韩文链：韩文正体在中文正体之前", at(koChain, MALGUN) >= 0 && at(koChain, MALGUN) < at(koChain, YAHEI));
  ok("每条链都从界面西文正体开始（西文与西文标点仍走界面字体）", zhChain[0] === "Inter" && jaChain[0] === "Inter" && koChain[0] === "Inter");

  console.log("\n--- 实际字体栈（前 4 个 family）---");
  const head2 = (label: string, s: string) => console.log("  " + label + ": " + s.split(", ").slice(0, 9).join(" | "));
  head2("中文行", sZh);
  head2("日文行", sJa);
  head2("韩文行", sKo);
  head2("西文行", sLat);
  console.log("\n结果：通过 " + pass + " / 失败 " + fail);
  return fail;
}
