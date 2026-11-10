/**
 * 歌词字体设置（文档 §9 / §11）：字体库 + 六份语言档案 + 缺字策略。
 *
 * 三个刻意的取舍：
 *   1) 档案只有"一个主字体 + 一个备用"，没有多选列表 —— 多选之后谁在前取决于点击顺序，
 *      同一份选择集合会得出不同结果，这正是旧方案被推翻的原因；
 *   2) 导入完不自动套用，只在下面提示"去档案里挑"（§4.2 不允许静默改用户的配置）；
 *   3) 每个档案都带预览句 + 缺字提示：字体选得对不对，不用去歌词页试。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { FontResource } from "../api/types";
import { Icon } from "./Icon";
import { useSettingsStore } from "../stores/settingsStore";
import { forgetRegistered, ensureFontsRegistered, useFontStore } from "../stores/fontStore";
import { toast, useUiStore } from "../stores/uiStore";
import {
  FONT_SOURCE_KEY,
  POLICY_OPTIONS,
  PROFILES_KEY,
  PROFILE_LIST,
  applyPolicy,
  buildStacks,
  fontFamilyName,
  forgetFont,
  missingSampleChars,
  readProfiles,
  readShowSource,
  serializeProfiles,
  sharedPolicy,
} from "../lib/lyricFont";
import type { FontProfileId, FontProfiles } from "../lib/lyricFont";

/** 字体文件对话框的扩展名过滤（和后端 SUPPORTED_EXTENSIONS 保持一致） */
const FONT_FILTERS = [{ name: "字体文件", extensions: ["ttf", "otf", "ttc", "woff", "woff2"] }];

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}

/** 这个字体能压住哪些文字系统（只列够用的，免得每个都写"0%"） */
function coverageTags(r: FontResource): string[] {
  if (!r.parsed) return [];
  const tags: string[] = [];
  if (r.coverage.latin >= 60) tags.push("拉丁");
  if (r.coverage.hanCommon >= 20) tags.push("汉字 " + Math.round(r.coverage.hanCommon) + "%");
  else if (r.coverage.hanExt >= 5) tags.push("扩展汉字");
  if (r.coverage.kana >= 50) tags.push("假名");
  if (r.coverage.hangul >= 30) tags.push("谚文");
  if (r.coverage.symbols >= 50) tags.push("符号");
  if (r.coverage.emoji >= 10) tags.push("Emoji");
  return tags;
}

export function LyricFontSettings() {
  const settings = useSettingsStore((s) => s.values);
  const setSetting = useSettingsStore((s) => s.set);
  const openDialog = useUiStore((s) => s.openDialog);

  const resources = useFontStore((s) => s.resources);
  const status = useFontStore((s) => s.status);
  const error = useFontStore((s) => s.error);
  const load = useFontStore((s) => s.load);
  const importFiles = useFontStore((s) => s.importFiles);
  const removeFont = useFontStore((s) => s.remove);
  const importing = useFontStore((s) => s.importing);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const profiles = useMemo(() => readProfiles(settings), [settings]);
  const stacks = useMemo(() => buildStacks(profiles, resources), [profiles, resources]);
  const showSource = readShowSource(settings);

  // 预览要能看到导入字体本身：把用到的字体注册进文档，注册完再刷一次
  const usedIds = useMemo(
    () => Array.from(new Set(Object.values(stacks).flatMap((s) => s.userFontIds))),
    [stacks]
  );
  const usedKey = usedIds.join("|");
  const [, setEpoch] = useState(0);
  useEffect(() => {
    if (!usedIds.length) return;
    let alive = true;
    void ensureFontsRegistered(usedIds).then(() => {
      if (alive) setEpoch((n) => n + 1);
    });
    return () => {
      alive = false;
    };
    // 依赖用 join 出来的键，理由同 LyricsPage：数组身份每次都变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usedKey]);

  const persist = useCallback(
    async (next: FontProfiles) => {
      try {
        await setSetting(PROFILES_KEY, serializeProfiles(next));
      } catch (e) {
        toast("保存字体设置失败：" + String(e), "error");
      }
    },
    [setSetting]
  );

  const setPrimary = (id: FontProfileId, fontId: string) => {
    void persist({ ...profiles, [id]: { ...profiles[id], primaryFontId: fontId || null } });
  };
  const setFallback = (id: FontProfileId, fontId: string) => {
    void persist({ ...profiles, [id]: { ...profiles[id], fallbackFontIds: fontId ? [fontId] : [] } });
  };

  /** 导入：选文件 → 后端解析入库 → 只给提示，不动档案配置 */
  const handleImport = async () => {
    let picked: string | string[] | null = null;
    try {
      picked = await open({ multiple: true, title: "选择字体文件", filters: FONT_FILTERS });
    } catch (e) {
      toast("打开文件选择器失败：" + String(e), "error");
      return;
    }
    const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter((p) => typeof p === "string");
    if (!paths.length) return;

    const report = await importFiles(paths);
    if (!report) {
      toast("导入失败，请重试", "error");
      return;
    }
    const parts: string[] = [];
    if (report.imported.length) parts.push("导入 " + report.imported.length + " 个");
    if (report.duplicates.length) parts.push(report.duplicates.length + " 个已在字体库里");
    if (report.failed.length) parts.push(report.failed.length + " 个失败");
    toast(parts.join("，") || "没有导入任何字体", report.failed.length ? "error" : "success");

    if (report.failed.length) {
      openDialog({
        kind: "confirm",
        title: "这些文件没能导入",
        message: report.failed.map((f) => f.path + "：" + f.message).join("；"),
        confirmText: "知道了",
        onConfirm: () => undefined,
      });
    }
    if (report.imported.length) {
      // 只提示不代设：用户得自己决定这个字体归哪个语言
      toast("导入成功，去下面的语言档案里把它设为主字体", "info");
    }
  };

  const doRemove = async (r: FontResource) => {
    try {
      await removeFont(r.id);
      forgetRegistered(r.id);
      const next = forgetFont(profiles, r.id);
      if (next.touched.length) await persist(next.profiles);
      toast("已删除「" + r.family + "」", "success");
    } catch (e) {
      toast("删除失败：" + String(e), "error");
    }
  };

  const confirmRemove = (r: FontResource) => {
    const usedBy = PROFILE_LIST.filter((p) => {
      const prof = profiles[p.id];
      return prof.primaryFontId === r.id || prof.fallbackFontIds.includes(r.id);
    }).map((p) => p.label);
    openDialog({
      kind: "confirm",
      title: "删除字体",
      message:
        "从字体库删除「" + r.family + "」？" +
        (usedBy.length ? "这些档案会回到系统字体：" + usedBy.join("、") : "目前没有档案在用它。"),
      confirmText: "删除",
      onConfirm: () => void doRemove(r),
    });
  };

  const policy = sharedPolicy(profiles);
  const policyHint = POLICY_OPTIONS.find((o) => o.value === policy)?.hint ?? "";

  return (
    <>
      <div className="section-title">歌词字体</div>
      <div className="settings-block">
        <div className="lf-row">
          <div className="lf-label">字体库</div>
          <div className="lf-options">
            <button className="chip lf-chip" onClick={() => void handleImport()} disabled={importing}>
              {importing ? "导入中…" : "导入字体文件…"}
            </button>
            <span className="lf-hint">
              {status === "error"
                ? "读取字体库失败：" + (error ?? "未知错误")
                : resources.length
                  ? "已导入 " + resources.length + " 个字体（单个上限 64MB）"
                  : "支持 ttf / otf / ttc / woff / woff2；导入只是拷进字体库，不会改动任何已有设置"}
            </span>
          </div>
        </div>

        {resources.length > 0 && (
          <div className="font-lib">
            {resources.map((r) => {
              const tags = coverageTags(r);
              return (
                <div className="font-item" key={r.id}>
                  <div className="font-item-main">
                    <div className="font-item-head">
                      <span className="font-item-name" style={{ fontFamily: '"' + fontFamilyName(r.id) + '"' }}>
                        {r.family}
                      </span>
                      {r.subfamily && <span className="font-item-sub">{r.subfamily}</span>}
                      {r.variable && <span className="chip font-tag">可变</span>}
                      {r.italic && <span className="chip font-tag">斜体</span>}
                      {r.faces > 1 && <span className="chip font-tag">{r.faces} face</span>}
                    </div>
                    <div className="font-item-meta">
                      {formatBytes(r.byteSize)} · {r.format.toUpperCase()} · 码位 {r.codepoints}
                      {r.originalName ? " · " + r.originalName : ""}
                    </div>
                    <div className="font-item-tags">
                      {tags.length ? (
                        tags.map((t) => (
                          <span className="chip font-tag" key={t}>
                            {t}
                          </span>
                        ))
                      ) : (
                        <span className="chip font-tag is-warn">{r.parsed ? "没有常用字形覆盖" : "无法解析"}</span>
                      )}
                    </div>
                    {r.warning && <div className="font-item-warn">{r.warning}</div>}
                    {r.missing && (
                      <div className="font-item-warn">文件已不在磁盘上，请重新导入；引用它的档案会回到系统字体</div>
                    )}
                  </div>
                  <button className="lf-icon-btn" aria-label={"删除字体 " + r.family} onClick={() => confirmRemove(r)}>
                    <Icon name="trash" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {PROFILE_LIST.map((spec) => {
          const prof = profiles[spec.id];
          const primary = prof.primaryFontId ? resources.find((r) => r.id === prof.primaryFontId) ?? null : null;
          const missing = missingSampleChars(spec.id, primary);
          return (
            <div className="font-row" key={spec.id}>
              <div className="font-row-label">
                <div className="lf-label">{spec.label}</div>
                <div className="lf-hint">{spec.hint}</div>
              </div>
              <div className="font-row-body">
                <div className="font-row-selects">
                  <select
                    className="settings-select"
                    value={prof.primaryFontId ?? ""}
                    onChange={(e) => setPrimary(spec.id, e.target.value)}
                    aria-label={spec.label + " 主字体"}
                  >
                    <option value="">系统字体（默认）</option>
                    {resources.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.family}
                        {r.subfamily ? " " + r.subfamily : ""}
                      </option>
                    ))}
                  </select>
                  <select
                    className="settings-select"
                    value={prof.fallbackFontIds[0] ?? ""}
                    onChange={(e) => setFallback(spec.id, e.target.value)}
                    aria-label={spec.label + " 备用字体"}
                  >
                    <option value="">无备用字体</option>
                    {resources
                      .filter((r) => r.id !== prof.primaryFontId)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.family}
                        </option>
                      ))}
                  </select>
                </div>
                {/* 预览就是真实的渲染结果：链和歌词页一模一样 */}
                <div className="font-preview" style={{ fontFamily: stacks[spec.id].css }} lang={spec.lang}>
                  {spec.sample}
                </div>
                <div className="font-row-note">
                  {primary ? "主字体：" + primary.family : "主字体：系统字体"}
                  {missing.length > 0 && primary
                    ? " · 预览里缺 " + missing.length + " 个字（" + missing.join(" ") + "），缺字处走回退链"
                    : ""}
                </div>
              </div>
            </div>
          );
        })}

        <div className="lf-row">
          <div className="lf-label">缺字回退</div>
          <div className="lf-options">
            {POLICY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={"chip lf-chip" + (policy === o.value ? " active" : "")}
                onClick={() => void persist(applyPolicy(profiles, o.value))}
              >
                {o.label}
              </button>
            ))}
            <span className="lf-hint">{policyHint}（对所有语言档案生效）</span>
          </div>
        </div>

        <div className="lf-row">
          <div className="lf-label">来源标注</div>
          <div className="lf-options">
            <button
              type="button"
              className={"chip lf-chip" + (showSource ? " active" : "")}
              onClick={() => {
                const next = showSource ? "0" : "1";
                void setSetting(FONT_SOURCE_KEY, next).catch((e) => toast("保存失败：" + String(e), "error"));
              }}
            >
              {showSource ? "已开启" : "已关闭"}
            </button>
            <span className="lf-hint">
              歌词页把主字体没覆盖的字用点状下划线标出来，方便看出这个字体到底压不压得住
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
