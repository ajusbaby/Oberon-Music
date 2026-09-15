// 导入音乐：调用系统目录选择器 → 登记文件夹 → 触发扫描
import { open } from "@tauri-apps/plugin-dialog";
import { useLibraryStore } from "../stores/libraryStore";
import { toast } from "../stores/uiStore";

export async function pickAndAddMusicFolder(): Promise<void> {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择音乐文件夹",
    });
    const path = typeof selected === "string" ? selected : Array.isArray(selected) ? selected[0] : null;
    if (!path) return;
    await useLibraryStore.getState().addFolder(path);
    toast("已添加音乐文件夹，开始扫描…", "success");
    await useLibraryStore.getState().startScan();
  } catch (e) {
    toast("添加文件夹失败：" + String(e), "error");
  }
}
