/**
 * @fileoverview Next.js 啟動 instrumentation — 應用程式內排程器（CHANGE-110）
 * @description
 *   在 Next.js server 啟動時註冊殭屍處理回收（FIX-094 sweeper）的週期執行。
 *
 *   背景：FIX-094 實作了 sweeper 並在 Azure DEV 實測成功（sweptCount=13），
 *   但本專案自始至終沒有任何排程機制 —— sweeper 只能人工觸發，未設排程前
 *   卡住的文件會持續累積。本模組補上「誰來定期觸發」這一環。
 *
 *   直接呼叫 job 函數，不經 HTTP，因此不需要 CRON_SECRET。
 *
 * @module src/instrumentation
 * @since CHANGE-110
 * @lastModified 2026-07-27
 *
 * @remarks
 *   進程內排程成立的兩個前提（2026-07-27 於 Azure DEV 實測確認）：
 *   - `alwaysOn: true` —— 容器不會因閒置被卸載，timer 不被中斷
 *   - `numberOfWorkers: 1` —— 單一 worker，不會重複觸發
 *   若未來調整任一項，需重新評估本方案（多 instance 時 sweeper 仍冪等，
 *   僅產生多餘查詢；閒置卸載則會使排程失效）。
 *
 * @see claudedocs/4-changes/feature-changes/CHANGE-110-internal-scheduler-stuck-processing-sweeper.md
 * @see claudedocs/4-changes/bug-fixes/FIX-094-zombie-processing-stuck-unrecoverable.md
 */

// ============================================================
// Configuration
// ============================================================

/**
 * 掃描間隔（毫秒）
 *
 * FIX-094 原設計建議每 5 分鐘；「多久算卡住」由 STUCK_PROCESSING_THRESHOLD_MINUTES
 * 控制（預設 10 分鐘），那才是有調整需求的參數，故此間隔固定不做成可設定。
 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** 啟動後首次執行的延遲（毫秒）—— 讓 server 完成暖機再跑 */
const INITIAL_DELAY_MS = 60 * 1000;

// ============================================================
// Next.js Instrumentation Hook
// ============================================================

/**
 * Next.js 於 server 啟動時呼叫一次
 *
 * @description
 *   三道守衛皆通過才註冊排程：
 *   1. 僅 nodejs runtime（排除 edge runtime）
 *   2. ENABLE_INTERNAL_SCHEDULER 必須嚴格等於 "true"（預設關閉，本地與 CI 不受影響）
 *   3. 動態 import job 模組 —— 避免頂層 import 把 document.service / prisma
 *      整條依賴鏈拉進 instrumentation bundle（本專案已有 FIX-069 re2-wasm、
 *      FIX-083 pdfkit 兩次同類 bundle/trace 教訓）
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.ENABLE_INTERNAL_SCHEDULER !== 'true') return;

  const { triggerStuckProcessingSweep } = await import('@/jobs/stuck-processing-sweeper-job');

  // 防重入：sweep 實測僅 120ms，5 分鐘間隔重疊機率極低，但 DB 連線池
  // 才因耗盡出過事（FIX-132），避免病態情況下堆疊。
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

  // unref()：timer 不阻止進程正常退出。Next.js server 的 TCP handle
  // 會保持進程存活，排程照常運作。
  setTimeout(() => {
    void sweep();
    setInterval(() => void sweep(), SWEEP_INTERVAL_MS).unref();
  }, INITIAL_DELAY_MS).unref();

  // 此行是 Azure 上確認排程已註冊的唯一觀測點（驗收標準 #2），必須保留。
  // 專案無通用 logger（@/lib/logger 只存在於技術規格文檔），jobs/ 生態一律用 console。
  // eslint-disable-next-line no-console
  console.log('[InternalScheduler] stuck-processing sweeper registered', {
    intervalMinutes: SWEEP_INTERVAL_MS / 60_000,
    initialDelaySeconds: INITIAL_DELAY_MS / 1000,
  });
}
