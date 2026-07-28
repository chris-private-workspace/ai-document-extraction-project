/**
 * @fileoverview FIX-139 — essential seed 角色權限防漂移測試
 * @module tests/unit/prisma/essential-seed-permissions.test
 *
 * 背景：`prisma/seed-prod-essential.ts`（Azure 容器每次啟動都跑）刻意**不 import
 * `src/`** —— Dockerfile 以裸 tsc 單檔編譯它，`@/*` alias 解析不到，且 import
 * `../src/**` 會使 tsc 的 common root 上移、輸出路徑偏移，進而打斷
 * `docker-entrypoint.sh` 的執行路徑（該步驟在 `set -e` 下失敗即容器起不來）。
 *
 * 代價是權限值存在**兩份定義**。FIX-139 之前這兩份已經漂移：seed 寫點號
 * （`audit.view`）、程式碼常量用冒號（`audit:view`），`Array.includes` 精確比對
 * 永遠不中 → 所有非 wildcard 角色的權限判斷一律 false（FIX-134 對 Azure 的
 * Auditor 因此從未生效）。
 *
 * 本測試即為那份「單一真實來源」的替代保證：任一邊改動而未同步，CI 立刻紅。
 *
 * ⚠️ 只比對 **permissions**。`description` 刻意不比 —— seed 用英文（給 DB /
 *    運維看）、`ROLE_DESCRIPTIONS` 用中文（給 UI 看），兩者本就不同源。
 *
 * @since FIX-139 - 2026-07-28
 * @lastModified 2026-07-28
 * @see claudedocs/4-changes/bug-fixes/FIX-139-essential-seed-placeholder-permissions.md
 */

import { describe, it, expect } from 'vitest'

import { ROLES } from '../../../prisma/seed-prod-essential.roles'
import { ROLE_NAMES, ROLE_PERMISSIONS, getAllRoleNames } from '@/types/role-permissions'
import { getAllPermissions, isValidPermission } from '@/types/permissions'
import { permissionListHas, WILDCARD_PERMISSION } from '@/lib/auth/has-permission'

/** 從 essential seed 的角色定義中取出指定角色 */
function seedRole(name: string) {
  return ROLES.find((role) => role.name === name)
}

/** essential-seed-only 角色：不在 ROLE_NAMES（該常量只含可指派給人的 6 個角色） */
const SEED_ONLY_ROLES = ['System'] as const

describe('FIX-139 essential seed 角色涵蓋範圍', () => {
  it('should define every role listed in ROLE_NAMES', () => {
    for (const name of getAllRoleNames()) {
      expect(seedRole(name), `essential seed 缺少角色「${name}」`).toBeDefined()
    }
  })

  it('should define exactly the ROLE_NAMES roles plus the seed-only ones', () => {
    const expected = [...getAllRoleNames(), ...SEED_ONLY_ROLES].sort()
    expect(ROLES.map((r) => r.name).sort()).toEqual(expected)
  })

  it('should not contain duplicate role names (upsert key is name)', () => {
    const names = ROLES.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('FIX-139 權限值與 ROLE_PERMISSIONS 逐字對齊', () => {
  // System Admin 走 wildcard，語意等價但值不同 → 另行驗證（見下一個 describe）
  const alignedRoles = getAllRoleNames().filter((name) => name !== ROLE_NAMES.SYSTEM_ADMIN)

  it.each(alignedRoles)(
    'should match ROLE_PERMISSIONS exactly for %s',
    (name) => {
      // 順序也對齊 —— 讓兩份定義的 diff 一眼可讀，並避免漏項被排序掩蓋
      expect(seedRole(name)?.permissions).toEqual([...ROLE_PERMISSIONS[name]])
    }
  )
})

describe('FIX-139 System Admin wildcard 語意等價', () => {
  it('should keep the wildcard literal (not the expanded permission list)', () => {
    // 刻意保留 ['*']：未來新增權限自動涵蓋，無需回頭改 seed。
    // Azure DEV 上實際在用的 4 個帳號即持此值。
    expect(seedRole(ROLE_NAMES.SYSTEM_ADMIN)?.permissions).toEqual([WILDCARD_PERMISSION])
  })

  it('should cover every defined permission through the wildcard branch', () => {
    const permissions = seedRole(ROLE_NAMES.SYSTEM_ADMIN)?.permissions ?? []
    for (const permission of getAllPermissions()) {
      expect(permissionListHas(permissions, permission), `wildcard 未涵蓋 ${permission}`).toBe(true)
    }
  })
})

describe('FIX-139 權限字串格式迴歸守衛', () => {
  /** 允許不在 PERMISSIONS 常量中的例外值（wildcard + seed-only 角色專屬權限） */
  const ALLOWED_NON_PERMISSION_VALUES = [WILDCARD_PERMISSION, 'system:internal']

  it('should only use values defined in the PERMISSIONS constant', () => {
    for (const role of ROLES) {
      for (const permission of role.permissions) {
        if (ALLOWED_NON_PERMISSION_VALUES.includes(permission)) continue
        expect(
          isValidPermission(permission),
          `角色「${role.name}」的「${permission}」不是有效的 PERMISSIONS 值`
        ).toBe(true)
      }
    }
  })

  it('should never use dot-separated permissions (the exact FIX-139 defect)', () => {
    // 舊佔位值長這樣：'audit.view' / 'report.view' / 'system.internal'。
    // 點號在本專案的權限命名中沒有任何合法用途 → 出現即為漂移復發。
    const offenders = ROLES.flatMap((role) =>
      role.permissions.filter((p) => p.includes('.')).map((p) => `${role.name}: ${p}`)
    )
    expect(offenders).toEqual([])
  })

  it('should follow the resource:action[:scope] shape', () => {
    for (const role of ROLES) {
      for (const permission of role.permissions) {
        if (permission === WILDCARD_PERMISSION) continue
        expect(permission, `角色「${role.name}」的「${permission}」格式不符`).toMatch(
          /^[a-z]+:[a-z]+(:[a-z]+)?$/
        )
      }
    }
  })
})
