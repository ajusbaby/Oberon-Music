// settingsStore —— 应用设置（Zustand），读写后端 settings 表
import { create } from "zustand";
import * as api from "../api/ipc";

interface SettingsStoreState {
  values: Record<string, string>;
  refresh: () => Promise<void>;
  get: (key: string, fallback?: string) => string | undefined;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  values: {},
  async refresh() {
    try { set({ values: await api.settingsGetAll() }); } catch { /* 忽略 */ }
  },
  get(key, fallback) {
    const v = get().values[key];
    return v === undefined ? fallback : v;
  },
  async set(key, value) {
    await api.settingsSet(key, value);
    set({ values: { ...get().values, [key]: value } });
  },
  async remove(key) {
    await api.settingsDelete(key);
    const next = { ...get().values };
    delete next[key];
    set({ values: next });
  },
}));
