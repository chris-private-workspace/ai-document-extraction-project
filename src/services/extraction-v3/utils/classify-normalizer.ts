/**
 * @fileoverview classifiedAs 值正規化工具
 * @description
 *   將 GPT 輸出的 category/classifiedAs 值正規化為一致的 Title Case 格式。
 *   解決 GPT 輸出格式不一致的問題（底線、連字號、大小寫差異）。
 *
 * @module src/services/extraction-v3/utils/classify-normalizer
 * @since CHANGE-046
 * @lastModified 2026-07-22 (FIX-126)
 *
 * @example
 * ```typescript
 * normalizeClassifiedAs('Terminal_Handling_Charge')  // → 'Terminal Handling Charge'
 * normalizeClassifiedAs('cleaning-at-destination')   // → 'Cleaning At Destination'
 * normalizeClassifiedAs('FREIGHT CHARGES')           // → 'Freight Charges'
 * normalizeClassifiedAs('Delivery Order Fee')        // → 'Delivery Order Fee'
 * ```
 */

/**
 * 正規化 classifiedAs 值為 Title Case 格式
 *
 * @description
 *   GPT 輸出的 category 可能使用不同格式（底線、連字號、全大寫等），
 *   而用戶在 UI 配置的 filter 使用自然語言格式（空格分隔 Title Case）。
 *   此函數確保所有 classifiedAs 值統一為 Title Case 格式。
 *
 * 轉換規則：
 *   1. 底線 `_` 和連字號 `-` 替換為空格
 *   2. 去除首尾空白、壓縮連續空白
 *   3. 每個單詞首字母大寫、其餘小寫（Title Case）
 *
 * @param value - 原始 classifiedAs 值
 * @returns 正規化後的 Title Case 字串
 */
export function normalizeClassifiedAs(value: string): string {
  return value
    .replace(/[_-]/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * FIX-126 方案 A：英文複數 → 單數白名單
 *
 * @description
 *   僅列貨運發票費用名稱常見的複數詞，逐詞查表歸一。刻意不做通用 stemming
 *   （如一律去尾 `s`），避免 `gross` → `gros` 這類誤傷製造新的誤命中。
 */
const PLURAL_TO_SINGULAR: Record<string, string> = {
  charges: 'charge',
  fees: 'fee',
  costs: 'cost',
  surcharges: 'surcharge',
  expenses: 'expense',
  containers: 'container',
  documents: 'document',
  services: 'service',
  orders: 'order',
  rates: 'rate',
  taxes: 'tax',
  duties: 'duty',
};

/**
 * 標籤對照的正規化形式
 *
 * @description
 *   將欄位 label / lineItem 的 classifiedAs / alias 轉為統一的對照鍵，
 *   用於 CHANGE-094 的確定性費用回填。與 {@link normalizeClassifiedAs} 不同，
 *   此函數產出全小寫、去標點的形式，專供「相等 / 子字串」比對使用（非顯示用）。
 *
 * 轉換規則：
 *   1. 全部轉小寫
 *   2. 底線 `_`、連字號 `-` 與其他非字母數字字符替換為空格
 *   3. 壓縮連續空白、去除首尾空白
 *   4. 英文複數歸一為單數（FIX-126，白名單見 {@link PLURAL_TO_SINGULAR}）
 *
 * @param value - 原始標籤字串
 * @returns 正規化後的對照鍵（如 `"Terminal Handling Charges - Origin"` → `"terminal handling charge origin"`）
 * @since CHANGE-094
 * @lastModified FIX-126 (2026-07-22)
 */
export function canonicalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((token) => PLURAL_TO_SINGULAR[token] ?? token)
    .join(' ');
}

/**
 * 費用方向（起運地 / 目的地）
 * @since FIX-126
 */
export type ChargeDirection = 'origin' | 'destination';

const ORIGIN_TOKENS = new Set(['origin', 'orig']);
const DESTINATION_TOKENS = new Set(['destination', 'dest', 'dst']);

/**
 * 抽取字串中的費用方向標記
 *
 * @description
 *   FIX-126 方案 C 的基礎：以 {@link canonicalizeLabel} 分詞後，收集方向詞
 *   （origin/orig → `'origin'`；destination/dest/dst → `'destination'`）。
 *   呼叫端（`resolveUniqueChargeKey`）以此實施「方向為必要條件」：
 *   定義有方向時，候選必須帶相同方向才可參與比對。
 *
 * @param value - 原始字串（lineItem description / classifiedAs / field def label）
 * @returns 出現過的方向集合（可能為空、單一或兩者皆有）
 * @since FIX-126
 */
export function extractChargeDirections(value: string): Set<ChargeDirection> {
  const directions = new Set<ChargeDirection>();
  for (const token of canonicalizeLabel(value).split(' ')) {
    if (ORIGIN_TOKENS.has(token)) directions.add('origin');
    if (DESTINATION_TOKENS.has(token)) directions.add('destination');
  }
  return directions;
}

/**
 * 標籤對照結果種類
 * @since CHANGE-094
 */
export type LabelMatchKind = 'exact' | 'substring' | null;

/**
 * 判定候選字串與目標標籤的對照種類
 *
 * @description
 *   CHANGE-094 確定性回填的核心對照函數。比對 lineItem 的 `description` /
 *   `classifiedAs`（候選）與 field definition 的 `label` / `aliases`（目標）：
 *   - 正規化後完全相等 → `'exact'`（經 FIX-126 單複數歸一，`Terminal Handling
 *     Charges` 與 `Terminal Handling Charge` 視為相等）
 *   - **候選以完整詞包含目標**，且目標足夠長（≥ 8 字元且 ≥ 2 詞，
 *     避免 `"Fee"` / `"Charge"` 等通用短詞誤命中）→ `'substring'`
 *   - 其餘 → `null`
 *
 *   FIX-126：子字串命中改為**非對稱** —— 僅允許「候選（文件文字）⊇ 目標
 *   （定義名稱）」。文件文字多出計價後綴、方向、註記仍指向同一費用，是強證據；
 *   反向（定義名稱 ⊇ 較短的候選）代表文件寫的是更泛的費用名，認領進更具體的
 *   欄位屬誤配（實測 `HANDLING CHARGE` 被 `Terminal handling charge` 結尾吞掉）。
 *   副作用：無方向的候選不再子字串命中帶方向的定義（原為歧義放棄），行為
 *   從「歧義才放棄」明確化為「一律不命中」。
 *
 *   子字串對照刻意保守：呼叫端（回填）會在「多個目標皆子字串命中」時
 *   視為歧義並跳過，確保寧可不填、不可填錯。
 *
 * @param candidate - 候選字串（lineItem 的 description 或 classifiedAs）
 * @param target - 目標標籤（field def 的 label 或某個 alias）
 * @returns 對照種類
 * @since CHANGE-094
 * @lastModified FIX-126 (2026-07-22)
 */
export function matchLabel(candidate: string, target: string): LabelMatchKind {
  const a = canonicalizeLabel(candidate);
  const b = canonicalizeLabel(target);
  if (!a || !b) return null;
  if (a === b) return 'exact';

  const isWordBounded =
    a.includes(` ${b} `) || a.startsWith(`${b} `) || a.endsWith(` ${b}`);
  if (isWordBounded && b.length >= 8 && b.split(' ').length >= 2) {
    return 'substring';
  }
  return null;
}
