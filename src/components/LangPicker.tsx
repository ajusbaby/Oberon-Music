import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * 顶栏那颗「语言」下拉。
 *
 * 为什么不用 <select>：Windows 上原生弹出层由系统绘制 —— 白底、灰蓝高亮、
 * 直角阴影，跟歌词页的浅色流光完全不搭，CSS 也只能改 option 的两条颜色。
 * 这里自绘一个 listbox：玻璃面板 + 圆角 + 当前项打钩，键盘（↑↓ Home End
 * Enter Esc Tab）与鼠标都能操作，语义按 WAI-ARIA listbox 写。
 *
 * 只负责「现在选了哪个」，改配置的事交给调用方（歌曲级覆盖写 settings）。
 */

export interface LangPickerOption {
  id: string;
  label: string;
}

interface LangPickerProps {
  /** 当前值，和 options 里的某个 id 对齐 */
  value: string;
  options: LangPickerOption[];
  /** 左侧小标签，例如「语言」 */
  label: string;
  /** 无障碍名，说明这个下拉到底在改什么 */
  ariaLabel: string;
  title?: string;
  onChange: (id: string) => void;
  /** 展开/收起回调：歌词页用它压住「静止 3s 隐藏顶栏」的计时器 */
  onOpenChange?: (open: boolean) => void;
}

export function LangPicker({
  value,
  options,
  label,
  ariaLabel,
  title,
  onChange,
  onOpenChange,
}: LangPickerProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );
  const dividerIndex = options.length > 1 ? 0 : -1;
  const current = options[selectedIndex] ?? options[0];

  const close = useCallback((focusButton = false) => {
    setOpen(false);
    if (focusButton) btnRef.current?.focus();
  }, []);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  // 每次展开都把高亮放在当前项上，并把焦点交给面板（键盘直接可用）
  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex);
    popRef.current?.focus();
    // selectedIndex 只在展开那一刻取一次，后续选项随播放切换不需要重设
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 点面板外面收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  // 高亮项滚进可视区（选项不多，但窗口矮的时候会溢出）
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const commit = (index: number) => {
    const opt = options[index];
    if (!opt) return;
    if (opt.id !== value) onChange(opt.id);
    close(true);
  };

  const onButtonKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen((v) => !v);
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(active);
        break;
      case "Escape":
        // 拦住冒泡：歌词页的 Esc 是「退出歌词页」，这里只收起下拉
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case "Tab":
        close();
        break;
      default:
        break;
    }
  };

  return (
    <div className={"sl-lang" + (open ? " is-open" : "")} ref={rootRef}>
      <span className="sl-lang-name">{label}</span>
      <button
        ref={btnRef}
        type="button"
        id={baseId + "-btn"}
        className="sl-lang-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={open ? undefined : title}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKeyDown}
      >
        <span className="sl-lang-value">{current?.label ?? ""}</span>
        <svg className="sl-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.6 4.6 6 8l3.4-3.4" />
        </svg>
      </button>

      {open && (
        <div
          className="sl-lang-pop"
          role="listbox"
          aria-labelledby={baseId + "-btn"}
          tabIndex={-1}
          ref={popRef}
          onKeyDown={onListKeyDown}
        >
          {options.map((o, i) => (
            <div
              key={o.id}
              role="option"
              aria-selected={o.id === value}
              data-active={i === active ? "true" : "false"}
              className={
                "sl-lang-opt" +
                (i === active ? " is-active" : "") +
                (o.id === value ? " is-selected" : "") +
                (i === dividerIndex ? " has-divider" : "")
              }
              // 用 mousedown：点下去的瞬间就选中，不等 mouseup，也不会先被"点外部关闭"截胡
              onMouseDown={(e) => {
                e.preventDefault();
                commit(i);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="sl-lang-opt-label">{o.label}</span>
              <svg className="sl-tick" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.4 6.4 4.9 9 9.6 3.2" />
              </svg>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
