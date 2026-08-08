/**
 * @fileoverview Handler 層 API 認證閘（FIX-170）
 * @description
 *   為 Epic 19 模板類 API 提供 handler 層的 session 檢查，作為 middleware
 *   `handleApiAuthGate`（CHANGE-078 / WP-2）之外的**第二道防線**。
 *
 *   為何 middleware 已有閘仍需要這一層：
 *   - middleware 的閘由 `API_AUTH_GATE_MODE` 控制，設為 `monitor` 時只記錄不阻擋
 *   - Next.js 存在 middleware bypass 類型的漏洞（見 FIX-171 §第三批），
 *     單靠 Edge 層的閘等於把授權押在一道已知可被繞過的防線上
 *
 *   回應格式沿用 FIX-065 / FIX-067 既有的 top-level RFC 7807，與那批
 *   route 的 401 逐欄位一致，不另立新格式。
 *
 * @module src/lib/auth/api-session
 * @since FIX-170 - Epic 19 模板類 API 認證補強
 * @lastModified 2026-08-08
 *
 * @related
 *   - src/middleware.ts - 第一層（Edge）認證閘
 *   - src/lib/auth/city-permission.ts - hasPermission 權限判定
 */

import { NextResponse } from 'next/server'
import type { Session } from 'next-auth'
import { auth } from '@/lib/auth'
import { hasPermission } from '@/lib/auth/city-permission'
import type { Permission } from '@/types/permissions'

// ============================================================
// Types
// ============================================================

/**
 * 認證閘結果。
 *
 * 未通過時直接回傳組好的 `NextResponse`，呼叫端不需要知道是 401 還是 403。
 */
export type ApiSessionGate =
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse }

// ============================================================
// 認證閘
// ============================================================

/**
 * 要求請求帶有效 session；可選擇同時要求特定權限。
 *
 * @param permission - 選填。指定時，session 使用者必須具備該權限，否則回 403
 * @returns 通過時 `{ ok: true, session }`；未通過時 `{ ok: false, response }`
 *
 * @example
 *   // 只要求登入
 *   const gate = await requireApiSession()
 *   if (!gate.ok) return gate.response
 *
 * @example
 *   // 要求登入 + 特定權限
 *   const gate = await requireApiSession(PERMISSIONS.REPORT_EXPORT)
 *   if (!gate.ok) return gate.response
 */
export async function requireApiSession(permission?: Permission): Promise<ApiSessionGate> {
  const session = await auth()

  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          type: 'https://api.example.com/errors/unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Authentication required',
        },
        { status: 401 }
      ),
    }
  }

  if (permission && !hasPermission(session.user, permission)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          type: 'https://api.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'Insufficient permissions',
        },
        { status: 403 }
      ),
    }
  }

  return { ok: true, session }
}
