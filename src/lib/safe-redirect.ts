/**
 * @fileoverview 轉址目標白名單驗證
 * @description
 *   驗證使用者可控的轉址參數（`callbackUrl` / `returnUrl` 等），只放行站內相對路徑，
 *   阻擋 open redirect。
 *
 *   起因（FIX-171 / BUG-2）：登入與註冊流程直接把查詢參數 `callbackUrl` 餵給
 *   `redirect()` 與 `router.push()`，未做任何驗證。攻擊者可構造
 *   `/en/auth/login?callbackUrl=https://evil.example` 誘使使用者在**真實**登入頁
 *   完成認證後被導向外部站點 —— 這是釣魚常用的手法，因為登入過程本身完全正常。
 *
 *   對應 DoD Checklist #24 與 QID 150084（CWE-79 / OWASP A05:2025 Injection）。
 *
 * @module src/lib/safe-redirect
 * @author Development Team
 * @since FIX-171（2026-08-07）
 * @lastModified 2026-08-07
 */

/** 轉址失敗時的預設落點 */
const DEFAULT_FALLBACK = '/dashboard'

/**
 * 解析用的哨兵 base。不可能與真實來源相同，因此只要解析後 origin 有變，
 * 就代表傳入的值帶有自己的來源（絕對 URL 或 protocol-relative），必須拒絕。
 */
const SENTINEL_ORIGIN = 'https://safe-redirect.invalid'

/**
 * 將使用者可控的轉址目標收斂為安全的站內路徑
 *
 * @description
 *   採「先語法排除、再解析驗證」兩道關卡：
 *
 *   1. **語法排除** —— 必須以單一 `/` 開頭。這道關卡擋掉：
 *      - 絕對 URL（`https://evil.example`、`javascript:alert(1)`）
 *      - protocol-relative（`//evil.example`）—— 瀏覽器會補上當前協定後導向外部
 *      - 反斜線變形（`/\evil.example`、`\\evil.example`）—— 部分瀏覽器將 `\` 等同 `/`
 *
 *   2. **解析驗證** —— 以哨兵 base 解析，確認 origin 未被改寫。這道關卡是縱深防禦，
 *      涵蓋第一道未列舉到的變形（如夾帶 Tab / 換行等會被瀏覽器剝除的控制字元）。
 *
 *   通過後回傳正規化的 `pathname + search + hash`，保留原本要返回的頁面位置。
 *
 * @param url - 待驗證的轉址目標（通常來自查詢參數）
 * @param fallback - 驗證未通過時的落點，預設 `/dashboard`
 * @returns 可安全使用的站內路徑
 *
 * @example
 * ```typescript
 * toSafeRedirect('/zh-TW/documents')        // → '/zh-TW/documents'
 * toSafeRedirect('/documents?page=2#top')   // → '/documents?page=2#top'
 * toSafeRedirect('https://evil.example')    // → '/dashboard'
 * toSafeRedirect('//evil.example')          // → '/dashboard'
 * toSafeRedirect('/\\evil.example')         // → '/dashboard'
 * toSafeRedirect(undefined)                 // → '/dashboard'
 * ```
 */
export function toSafeRedirect(
  url: string | undefined | null,
  fallback: string = DEFAULT_FALLBACK
): string {
  if (!url) return fallback

  // 第一道：語法排除
  if (!url.startsWith('/')) return fallback
  if (url.startsWith('//')) return fallback
  if (url.startsWith('/\\')) return fallback

  // 第二道：解析後 origin 必須維持不變
  try {
    const resolved = new URL(url, SENTINEL_ORIGIN)
    if (resolved.origin !== SENTINEL_ORIGIN) return fallback

    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return fallback
  }
}
