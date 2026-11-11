/**
 * 通用自绘下拉（设置页用）。
 *
 * 为什么不用 <select>：Windows 上原生弹出层由系统绘制 —— 灰底、灰蓝高亮、直角
 * 阴影，跟这套浅色界面完全不搭，CSS 也只能改 option 的两条颜色。这里自绘一个
 * listbox：白面板 + 圆角 + 阴影 + 当前项打钩，键盘（↑↓ Home End Enter Space
 * Esc Tab）与鼠标都能用，语义按 WAI-ARIA listbox 写。
 *
 * 面板用 createPortal 挂到 document.body 并 position:fixed：设置页的内容在
 * .list-viewport 里滚动，面板如果留在原地会被 overflow 裁掉；fixed 之后它也不
 * 会跟着行内布局跳动。滚动/改窗口大小直接收起（原生 select 也是这个行为）。
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** 无障碍名：说明这个下拉到底在改什么 */
  ariaLabel: string;
  /** 附加在根节点上，用来调宽度（例如 .font-row-selects 里的窄版） */
  className?: string;
  disabled?: boolean;
  title?: string;
  /** 值不在 options 里时显示的文字（默认留空） */
  placeholder?: string;
}

interface PanelPos {
  left: number;
  top: number;
  minWidth: number;
  maxHeight: number;
  placed: boolean;
}

const GAP = 6; // 按钮与面板的间距
const EDGE = 10; // 面板与窗口边缘的最小距离
const MIN_BTN_WIDTH = 176;

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  disabled,
  title,
  placeholder,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<PanelPos | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();

  const indexOfValue = options.findIndex((o) => o.value === value);
  const current = indexOfValue >= 0 ? options[indexOfValue] : undefined;

  const close = useCallback((focusBack = false) => {
    setOpen(false);
    setPos(null);
    if (focusBack) btnRef.current?.focus();
  }, []);

  // 展开那一刻：高亮落在当前项，焦点交给面板（键盘直接可用）
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const t = window.setTimeout(() => popRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
    // 只跟着 open 走：后续选项变化不该把高亮抢回去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 量一次面板的天然高度/宽度，再决定往上还是往下弹、要不要压高度
  useLayoutEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const r = btn.getBoundingClientRect();
    const natural = pop.scrollHeight;
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    // 下面放不下且上面更宽裕时往上弹（设置页底部的几个下拉会用到）
    const up = natural > below && above > below;
    const maxHeight = Math.max(96, Math.min(natural, up ? above : below));
    const minWidth = Math.max(r.width, MIN_BTN_WIDTH);
    const width = Math.max(pop.offsetWidth, minWidth);
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE));
    const top = up ? Math.max(EDGE, r.top - GAP - Math.min(natural, maxHeight)) : r.bottom + GAP;
    setPos({ left, top, minWidth, maxHeight, placed: true });
  }, [open]);

  // 展开期间：点外面收起、Esc 收起、滚动/改大小收起
  useEffect(() => {
    if (!open) return;
    const hide = () => {
      setOpen(false);
      setPos(null);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      hide();
      btnRef.current?.focus();
    };
    const onScroll = (e: Event) => {
      // 面板自己滚动不收起（选项多的时候要能滚）
      const t = e.target as Node | null;
      if (t && popRef.current?.contains(t)) return;
      hide();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  // 高亮项滚进可视区
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const commit = (index: number) => {
    const opt = options[index];
    if (!opt) return;
    if (opt.value !== value) onChange(opt.value);
    close(true);
  };

  const onButtonKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) close(true);
      else setOpen(true);
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
    <div
      className={"ui-select" + (open ? " is-open" : "") + (className ? " " + className : "")}
      ref={rootRef}
      title={title}
    >
      <button
        ref={btnRef}
        type="button"
        id={baseId + "-btn"}
        className="ui-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onButtonKeyDown}
      >
        <span className="ui-select-value">{current ? current.label : placeholder ?? ""}</span>
        <svg className="ui-select-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.6 4.6 6 8l3.4-3.4" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            className="ui-select-pop"
            role="listbox"
            aria-labelledby={baseId + "-btn"}
            tabIndex={-1}
            data-placed={pos?.placed ? "true" : "false"}
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              minWidth: pos?.minWidth ?? MIN_BTN_WIDTH,
              maxHeight: pos ? pos.maxHeight : undefined,
            }}
            onKeyDown={onListKeyDown}
          >
            {options.length === 0 && <div className="ui-select-empty">没有可选项</div>}
            {options.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                data-active={i === active ? "true" : "false"}
                className={
                  "ui-select-opt" +
                  (i === active ? " is-active" : "") +
                  (o.value === value ? " is-selected" : "")
                }
                // 用 mousedown：按下的瞬间就选中，不等 mouseup，也不会先被「点外部关闭」截胡
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(i);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="ui-select-opt-label">{o.label}</span>
                <svg className="ui-select-tick" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2.4 6.4 4.9 9 9.6 3.2" />
                </svg>
              </div>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
