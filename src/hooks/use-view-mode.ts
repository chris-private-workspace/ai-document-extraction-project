'use client';

/**
 * @fileoverview 列表「卡片 / 列表」檢視模式 Hook（localStorage 持久化）
 * @description
 *   提供受控的檢視模式狀態，並以 localStorage 記憶使用者上次選擇。
 *   - SSR 安全：伺服器端與首次 render 一律使用 defaultMode，掛載後才讀取 localStorage
 *     （避免 hydration mismatch；localStorage 有值時於 client 端切換）
 *   - localStorage 不可用時（隱私模式 / 停用）優雅退化為 defaultMode
 *
 * @module src/hooks/use-view-mode
 * @since CHANGE-093
 * @lastModified 2026-06-26
 */

import * as React from 'react';

/** 檢視模式：卡片網格 / 列表表格 */
export type ViewMode = 'card' | 'list';

/**
 * 受控檢視模式 Hook（localStorage 持久化）
 *
 * @param storageKey localStorage 鍵名（每頁獨立，如 `dataTemplates.viewMode`）
 * @param defaultMode 預設模式（預設 `card`）
 * @returns `[viewMode, setViewMode]`
 */
export function useViewMode(
  storageKey: string,
  defaultMode: ViewMode = 'card'
): [ViewMode, (mode: ViewMode) => void] {
  const [viewMode, setViewModeState] = React.useState<ViewMode>(defaultMode);

  // 掛載後讀取 localStorage（SSR-safe）
  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === 'card' || saved === 'list') {
        setViewModeState(saved);
      }
    } catch {
      // localStorage 不可用 → 維持 defaultMode
    }
  }, [storageKey]);

  const setViewMode = React.useCallback(
    (mode: ViewMode) => {
      setViewModeState(mode);
      try {
        window.localStorage.setItem(storageKey, mode);
      } catch {
        // 忽略寫入失敗
      }
    },
    [storageKey]
  );

  return [viewMode, setViewMode];
}
