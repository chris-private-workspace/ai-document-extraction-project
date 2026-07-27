/**
 * @fileoverview Next.js 啟動 instrumentation（CHANGE-110）
 * @description
 *   在 Next.js server 啟動時啟動應用程式內排程器（殭屍處理回收，FIX-094）。
 *
 * @module src/instrumentation
 * @since CHANGE-110
 * @lastModified 2026-07-27
 *
 * @remarks
 *   🔴 本檔案必須保持極簡，**所有** node-only 依賴一律放在
 *   `process.env.NEXT_RUNTIME === 'nodejs'` 條件區塊**內**動態 import。
 *
 *   原因：Next.js 為 instrumentation 同時編譯 nodejs 與 edge 兩份 bundle，而
 *   edge runtime 沒有 fs / path / stream / child_process。`await import()` 並
 *   **不會**讓 webpack 略過打包 —— 它只延遲執行，模組仍會被靜態分析。唯一能讓
 *   edge bundle 不去解析的方式，是把 import 放進以 `NEXT_RUNTIME`（build 時會被
 *   替換為字面值）為條件的區塊，讓 webpack 的 dead-code elimination 整段消除。
 *
 *   曾踩：初版寫成 `if (process.env.NEXT_RUNTIME !== 'nodejs') return;` 的早期
 *   返回，import 落在區塊外 → DCE 消不掉 → `next build` 失敗於
 *   `Can't resolve 'fs'`（pg）與 `'child_process'`（sharp）。
 *   詳見 CHANGE-110「實作路上的一個錯誤判斷」。
 *
 * @see claudedocs/4-changes/feature-changes/CHANGE-110-internal-scheduler-stuck-processing-sweeper.md
 */

/**
 * Next.js 於 server 啟動時呼叫一次
 *
 * @description
 *   兩個條件皆滿足才啟動排程：
 *   1. `NEXT_RUNTIME === 'nodejs'`（排除 edge runtime，同時讓 edge bundle DCE 掉整段）
 *   2. `ENABLE_INTERNAL_SCHEDULER === 'true'`（嚴格比對；預設關閉，本地與 CI 不受影響）
 */
export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.ENABLE_INTERNAL_SCHEDULER === 'true'
  ) {
    const { startInternalScheduler } = await import('./jobs/internal-scheduler');
    startInternalScheduler();
  }
}
