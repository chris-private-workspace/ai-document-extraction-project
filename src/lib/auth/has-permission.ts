/**
 * @fileoverview 統一權限判斷入口（FIX-134）
 * @description
 *   系統中原有**三套彼此不相通**的「是不是全域管理員」判斷方式：
 *   1. `session.user.isGlobalAdmin` 布林欄位（auth 核心、grant-global-admin.js）
 *   2. `role.permissions` 陣列含 wildcard `*`（25 個檔案）
 *   3. role **名稱**等於 `GLOBAL_ADMIN`（`/api/audit/reports` 等）
 *
 *   實際帳號的資料形狀（2026-07-27 Azure DEV 實測 `admin@rci-t.com`）：
 *   `isGlobalAdmin: true`、`roles: [{ name: 'System Admin', permissions: ['*'] }]`
 *   —— 方式 3 會判定「不是」（角色名為 `System Admin`），方式 2 只在該檔顯式寫了
 *   wildcard 分支時才成立。結果全域管理員在部分端點被 403 擋下。
 *
 *   本模組是唯一入口：API route、服務層與前端 hook 一律委派此處，
 *   讓「擁有某權限」只有一種語意。
 *
 * @module src/lib/auth/has-permission
 * @since FIX-134
 * @lastModified 2026-07-27
 *
 * @see claudedocs/4-changes/bug-fixes/FIX-134-global-admin-permission-identification-inconsistent.md
 */

import { PERMISSIONS } from '@/types/permissions';

/** 代表「所有權限」的 wildcard（存於 `Role.permissions` 陣列中的字面字串） */
export const WILDCARD_PERMISSION = '*';

/**
 * 權限判斷所需的最小 session user 形狀
 *
 * @remarks
 *   刻意不直接依賴 `next-auth` 的 `Session['user']`，讓服務層與測試能傳入
 *   等價的最小物件。實際的 session 物件結構相容。
 */
export interface PermissionSubject {
  isGlobalAdmin?: boolean;
  roles?: Array<{ permissions: string[] }>;
}

/**
 * 判斷 session user 是否擁有指定權限
 *
 * @param user - session user（可為 undefined / null，回 false 不拋錯）
 * @param permission - 權限代碼（如 `PERMISSIONS.INVOICE_REVIEW`）
 * @returns 是否擁有該權限
 *
 * @remarks
 *   判斷順序：`isGlobalAdmin` → wildcard `*` → 精確比對。三種既有方式一次涵蓋。
 *
 *   ⚠️ `['*'].includes('INVOICE_REVIEW')` 為 `false` —— wildcard 是**字面字串**，
 *   `Array.prototype.includes` 只做精確比對，永遠不會把它展開。這正是 FIX-134 的
 *   BUG-1／BUG-2 根因，故此處必須顯式處理。
 */
export function sessionHasPermission(
  user: PermissionSubject | null | undefined,
  permission: string
): boolean {
  if (!user) return false;
  if (user.isGlobalAdmin) return true;
  return (user.roles ?? []).some(
    (role) =>
      role.permissions.includes(WILDCARD_PERMISSION) || role.permissions.includes(permission)
  );
}

/**
 * 判斷 session user 是否擁有其中任一權限
 *
 * @param user - session user
 * @param permissions - 權限代碼陣列（空陣列回 false —— 沒有任何要求可滿足）
 */
export function sessionHasAnyPermission(
  user: PermissionSubject | null | undefined,
  permissions: string[]
): boolean {
  return permissions.some((p) => sessionHasPermission(user, p));
}

/**
 * 判斷 session user 是否擁有全部權限
 *
 * @param user - session user
 * @param permissions - 權限代碼陣列（空陣列回 true，沿用 `Array.every` 語意）
 */
export function sessionHasAllPermissions(
  user: PermissionSubject | null | undefined,
  permissions: string[]
): boolean {
  return permissions.every((p) => sessionHasPermission(user, p));
}

/**
 * 判斷 session user 是否具有審計存取權（FIX-134 BUG-3）
 *
 * @description
 *   取代原本散落 7 個檔案的 `['AUDITOR', 'GLOBAL_ADMIN'].includes(role.name)`
 *   角色**名稱**比對 —— 這兩個字串**都不是實際角色名**：
 *   `ROLE_NAMES.AUDITOR` 是 `'Auditor'`、全域管理員角色叫 `'System Admin'`
 *   （見 `src/types/role-permissions.ts`）。名稱一律對不上，判斷永遠為 false。
 *
 *   改以權限為準：`Auditor` 角色持有 `AUDIT_VIEW`／`AUDIT_EXPORT`，
 *   而全域管理員憑 `isGlobalAdmin` 或 wildcard 通過。兩者皆比名稱比對可靠。
 *
 * @param user - session user
 * @returns 是否可存取審計資源
 */
export function sessionHasAuditAccess(user: PermissionSubject | null | undefined): boolean {
  return sessionHasAnyPermission(user, [PERMISSIONS.AUDIT_VIEW, PERMISSIONS.AUDIT_EXPORT]);
}

/**
 * 判斷一組**已展平的權限字串**是否涵蓋指定權限
 *
 * @description
 *   給只拿得到權限陣列、拿不到完整 session 的呼叫點使用
 *   （如 `role.service.ts` 的 `getUserPermissions()` 結果）。
 *   同樣認得 wildcard，但**無法**檢查 `isGlobalAdmin` —— 該資訊不在權限陣列裡。
 *
 * @param permissions - 已展平的權限字串陣列
 * @param permission - 要檢查的權限代碼
 */
export function permissionListHas(permissions: string[], permission: string): boolean {
  return permissions.includes(WILDCARD_PERMISSION) || permissions.includes(permission);
}
