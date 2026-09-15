fn main() {
    tauri_build::build();

    // 图标/配置改了要重编本包。
    //
    // tauri-build 只声明 tauri.conf.json 的 rerun-if-changed，不看 icons/；
    // 而窗口图标是在 tauri-codegen 的 proc macro（generate_context!）里 include 进二进制的，
    // proc macro 读了什么文件 cargo 也无从得知。于是会出现这种坑：
    // 重新生成了图标 → cargo build 认为什么都没变 → 二进制里还是旧图标 →
    // 「文件明明换了，任务栏还是马赛克」。这里显式声明，保证换图标必重编。
    for path in [
        "icons/icon.ico",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
}
