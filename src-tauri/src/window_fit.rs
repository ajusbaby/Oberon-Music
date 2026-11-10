//! 启动时按显示器工作区定窗口尺寸。
//!
//! tauri.conf.json 里的 1064×794 是「理想尺寸」，不是所有机器都放得下：
//! 14 寸笔记本常见的 1920×1080@150% 只有约 1280×680 逻辑像素可用，
//! 照配置开窗会上下出屏，而配置里写死的 minHeight 768 还让用户连拖小都拖不动。
//!
//! 这里的做法是：窗口以 visible:false 建出来 → show → 量工作区 → 先降下限再改
//! 尺寸 → 居中。下限也必须跟着工作区走，否则「最小尺寸」本身就超出屏幕。

use tauri::{Monitor, PhysicalPosition, WebviewWindow};

/// 设计稿尺寸（逻辑像素）
pub const DESIGN_W: f64 = 1064.0;
pub const DESIGN_H: f64 = 794.0;

/// 布局还站得住的下限。再小就该上紧凑样式了，而不是继续压窗口。
pub const FLOOR_W: f64 = 960.0;
pub const FLOOR_H: f64 = 600.0;

/// 四周留 8px 边：贴满整个工作区时窗口边框会和工作区边缘粘在一起，
/// 而且最大化后用户没法用鼠标抓住边框。工作区本身已经扣过任务栏，
/// 所以这里不需要再按百分比让位。
const MARGIN_PX: f64 = 8.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit {
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
}

/// 给定工作区的逻辑宽高，算出窗口尺寸与下限。
///
/// 下限同样被工作区夹住：工作区比地板还小的机器（远程桌面、老上网本）如果
/// 还坚持 960×600，用户永远拖不到「完整可见」的状态。
pub fn fit_for(work_w: f64, work_h: f64) -> Fit {
    let work_w = work_w.max(1.0);
    let work_h = work_h.max(1.0);
    let min_width = FLOOR_W.min(work_w);
    let min_height = FLOOR_H.min(work_h);
    let width = DESIGN_W.min((work_w - MARGIN_PX).max(min_width)).min(work_w);
    let height = DESIGN_H.min((work_h - MARGIN_PX).max(min_height)).min(work_h);
    Fit { width, height, min_width, min_height }
}

/// 把主窗口塞进它所在显示器的工作区。返回值表示是否真的量到了显示器并应用了尺寸。
///
/// 拿不到显示器信息时返回 Ok(false)，由调用方决定要不要等窗口聚焦后再试一次 ——
/// 配置里的 960×600 下限已经足够保守，不会开出一个必然出屏的窗口。
pub fn fit_window(win: &WebviewWindow) -> tauri::Result<bool> {
    // 必须是 .ok().flatten()，不能用 ?：setup 阶段窗口刚显示，
    // current_monitor() 会返回 Err（窗口还没挂到任何显示器上）。
    // 用 ? 会让整个函数在这一步就悄悄返回，后面的尺寸调整永远执行不到。
    let mon = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(mon) = mon else {
        return Ok(false);
    };
    let sf = mon.scale_factor();
    let wa = mon.work_area();
    let f = fit_for(wa.size.width as f64 / sf, wa.size.height as f64 / sf);
    // 顺序不能反：先把下限降下来再改尺寸，否则 set_size 会被旧下限弹回去。
    win.set_min_size(Some(tauri::LogicalSize::new(f.min_width, f.min_height)))?;
    win.set_size(tauri::LogicalSize::new(f.width, f.height))?;
    center_on(win, &mon);
    Ok(true)
}

/// 按「刚量到的那块工作区」居中（物理像素）。
///
/// 不用 win.center()：它内部会再查一次 current_monitor，查不到就直接 Err ——
/// 而启动那一瞬间正是最容易查不到的时刻。查失败的结果就是窗口留在创建时的
/// (0,0)，用户看到的就是「播放器跑到左上角」。这里改成用已经量到的 mon 自己算，
/// 只在算不出外部尺寸时才退回 center()。
fn center_on(win: &WebviewWindow, mon: &Monitor) {
    let wa = mon.work_area();
    let Ok(outer) = win.outer_size() else {
        let _ = win.center();
        return;
    };
    let x = wa.position.x as i64 + (wa.size.width as i64 - outer.width as i64) / 2;
    let y = wa.position.y as i64 + (wa.size.height as i64 - outer.height as i64) / 2;
    if win
        .set_position(PhysicalPosition::new(x as i32, y as i32))
        .is_err()
    {
        let _ = win.center();
    }
}

/// 兜底：窗口还贴在 (0,0)（创建时的默认落点）就强制居中一次。只在启动阶段调用，
/// 此时用户还没机会自己挪窗口，所以「(0,0) = 没摆好」是安全的判断。
pub fn rescue_offscreen(win: &WebviewWindow) {
    let Ok(pos) = win.outer_position() else {
        return;
    };
    if pos.x > 0 || pos.y > 0 {
        return;
    }
    let mon = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());
    if let Some(mon) = mon {
        center_on(win, &mon);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验收矩阵：每条都要求「窗口完整落在工作区内，且最小尺寸也不越界」。
    /// 括号里是逻辑像素（物理分辨率 ÷ 系统缩放，再扣任务栏）。
    #[test]
    fn every_screen_profile_fits_inside_its_work_area() {
        for (w, h) in [
            (1920.0, 1040.0), // 1920×1080 @100%
            (1536.0, 816.0),  // 1920×1080 @125%
            (1280.0, 680.0),  // 1920×1080 @150% ← 14 寸最常见
            (1280.0, 760.0),  // 2560×1600 @200%
            (1440.0, 860.0),  // 2880×1800 @200%（MacBook 14）
            (1366.0, 728.0),  // 1366×768 @100%
            (1707.0, 912.0),  // 2560×1440 @150%
            (3840.0, 2100.0), // 4K @100%
            (1024.0, 560.0),  // 远程桌面 / 老机器：比地板还小
        ] {
            let f = fit_for(w, h);
            assert!(f.width <= w + 1e-9, "{w}×{h}：宽 {} 越界", f.width);
            assert!(f.height <= h + 1e-9, "{w}×{h}：高 {} 越界", f.height);
            assert!(f.min_width <= f.width + 1e-9, "{w}×{h}：下限比窗口还大");
            assert!(f.min_height <= f.height + 1e-9, "{w}×{h}：下限比窗口还大");
        }
    }

    #[test]
    fn laptop_150_percent_gets_a_shorter_window() {
        let f = fit_for(1280.0, 680.0);
        // 794 → 672：14 寸工作区仍需按可用高度收缩，宽度保持设计尺寸
        assert_eq!(f.width, DESIGN_W);
        assert_eq!(f.height, 672.0);
        // minHeight 768 是旧配置的硬伤，这里必须落到 600
        assert_eq!(f.min_height, FLOOR_H);
        assert_eq!(f.min_width, FLOOR_W);
    }

    #[test]
    fn oversized_screen_keeps_the_design_size() {
        let f = fit_for(3840.0, 2100.0);
        assert_eq!((f.width, f.height), (DESIGN_W, DESIGN_H));
        assert_eq!((f.min_width, f.min_height), (FLOOR_W, FLOOR_H));
    }

    #[test]
    fn screen_smaller_than_the_floor_lowers_the_floor() {
        // 1024×560：高度比地板 600 还小，下限必须让位，否则用户拖不到完整可见
        let f = fit_for(1024.0, 560.0);
        assert_eq!(f.min_width, FLOOR_W); // 宽度 1024 > 960，下限不用降
        assert_eq!(f.min_height, 560.0);
        assert_eq!(f.width, 1016.0);
        assert_eq!(f.height, 560.0);
    }
}
