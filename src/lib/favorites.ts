// 收藏：以 settings 表的 favorites 键（JSON 数组）持久化
import { useCallback, useMemo } from "react";
import { useSettingsStore } from "../stores/settingsStore";

export function useFavorites() {
  const raw = useSettingsStore((s) => s.values["favorites"]);
  const setSetting = useSettingsStore((s) => s.set);

  const favorites = useMemo<number[]>(() => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as number[]) : [];
    } catch {
      return [];
    }
  }, [raw]);

  const isFavorite = useCallback((trackId: number) => favorites.includes(trackId), [favorites]);

  const toggle = useCallback(
    (trackId: number) => {
      const next = favorites.includes(trackId)
        ? favorites.filter((id) => id !== trackId)
        : [...favorites, trackId];
      void setSetting("favorites", JSON.stringify(next));
    },
    [favorites, setSetting]
  );

  return { favorites, isFavorite, toggle };
}
