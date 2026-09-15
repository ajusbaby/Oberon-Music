// 防 Windows 控制台窗口（release 构建）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    oberon_lib::run();
}
