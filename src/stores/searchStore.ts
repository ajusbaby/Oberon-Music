// 搜索状态（输入即时查询，视图由 navStore 控制）
import { create } from "zustand";

interface SearchState {
  query: string;
  setQuery: (query: string) => void;
  clear: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: "",
  setQuery(query) {
    set({ query });
  },
  clear() {
    set({ query: "" });
  },
}));
