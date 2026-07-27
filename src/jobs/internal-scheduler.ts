/**
 * @fileoverview 應用程式內排程器 — 殭屍處理回收的週期執行（CHANGE-110）
 * @description
 *   由 src/instrumentation.ts 在 Next.js server 啟動時載入並啟動。
 *
 *   背景：FIX-094 實作了 sweeper 並在 Azure DEV 實測成功（sweptCount=13），
 *   但本專案沒有任何排程機制 —— sweeper 只能人工觸發，未設排程前卡住的文件
 *   會持續累積。本模組補上「誰來定期觸發」這一環。
 *
 *   直接呼叫 job 函數，不經 HTTP，因此不需要 CRON_SECRET。
 *
 * @module src/jobs/internal-scheduler
 * @since CHANGE-110
 * @lastModified 2026-07-27
 *
 * @remarks
 *   🔴 本模組**只能**由 instrumentation.ts 在 `NEXT_RUNTIME === 'nodejs'` 條件區塊內
 *   動態 import。它靜態 import 了 document.service（牽出 pg / sharp 等 node-only
 *   依賴），若被 Next.js 的 edge bundle 解析到會直接讓 `next build` 失敗
 *   （Can't resolve 'fs' / 'child_process'）。詳見 CHANGE-110「實作路上的一個錯誤判斷」。
 *
 * @see claudedocs/4-changes/feature-changes/CHANGE-110-internal-scheduler-stuck-processing-sweeper.md
 * @see claudedocs/4-changes/bug-fixes/FIX-094-zombie-processing-stuck-unrecoverable.md
 */

import { triggerStuckProcessingSweep } from '@/jobs/stuck-processing-sweeper-job';

// ============================================================
// Configuration
// ============================================================

/**
 * 掃描間隔（毫秒）
 *
 * FIX-094 原設計建議每 5 分鐘；「多久算卡住」由 STUCK_PROCESSING_THRESHOLD_MINUTES
 * 控制（預設 10 分鐘），那才是有調整需求的參數，故此間隔固定不做成可設定。
 */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** 啟動後首次執行的延遲（毫秒）—— 讓 server 完成暖機再跑 */
export const INITIAL_DELAY_MS = 60 * 1000;

// ============================================================
// Scheduler
// ============================================================

/**
 * 啟動殭屍處理回收的週期執行
 *
 * @description
 *   啟動後 60 秒首次執行，之後每 5 分鐘一次。
 *
 *   - 防重入：sweep 實測僅 120ms，5 分鐘間隔重疊機率極低，但 DB 連線池
 *     才因耗盡出過事（FIX-132），避免病態情況下堆疊。
 *   - `unref()`：timer 不阻止進程正常退出。Next.js server 的 TCP handle
 *     會保持進程存活，排程照常運作。
 */
export function startInternalScheduler(): void {
  let running = false;

  const sweep = async (): Promise<void> => {
    if (running) {
      console.warn('[InternalScheduler] previous sweep still running, skipping this tick');
      return;
    }
    running = true;
    try {
      await triggerStuckProcessingSweep();
    } catch (error) {
      // triggerStuckProcessingSweep 內部已捕捉並回傳結果，理論上不會拋出；
      // 此處為保險，確保單次失敗不會中斷後續週期。
      console.error('[InternalScheduler] stuck-processing sweep threw', error);
    } finally {
      running = false;
    }
  };

  setTimeout(() => {
    void sweep();
    setInterval(() => void sweep(), SWEEP_INTERVAL_MS).unref();
  }, INITIAL_DELAY_MS).unref();

  // 此行是 Azure 上確認排程已註冊的唯一觀測點（CHANGE-110 驗收標準 #2），必須保留。
  // 專案無通用 logger（@/lib/logger 只存在於技術規格文檔），jobs/ 生態一律用 console。
  // eslint-disable-next-line no-console
  console.log('[InternalScheduler] stuck-processing sweeper registered', {
    intervalMinutes: SWEEP_INTERVAL_MS / 60_000,
    initialDelaySeconds: INITIAL_DELAY_MS / 1000,
  });
}
