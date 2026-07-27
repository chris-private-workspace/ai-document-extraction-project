/**
 * @fileoverview FIX-134 統一權限判斷入口單元測試
 * @description
 *   涵蓋三套既有判斷方式的匯流：isGlobalAdmin 布林、wildcard `*`、精確比對，
 *   以及 undefined / null 的安全性與「無權限帳號仍被擋下」的回歸保護。
 *
 * @module tests/unit/lib/has-permission.test
 * @since FIX-134
 * @lastModified 2026-07-27
 */
import { describe, it, expect } from 'vitest'

import {
  sessionHasPermission,
  sessionHasAnyPermission,
  sessionHasAllPermissions,
  sessionHasAuditAccess,
  permissionListHas,
  WILDCARD_PERMISSION,
} from '@/lib/auth/has-permission'

/** 2026-07-27 Azure DEV 實測 admin@rci-t.com 的真實形狀 */
const GLOBAL_ADMIN = {
  isGlobalAdmin: true,
  roles: [{ permissions: [WILDCARD_PERMISSION] }],
}

/** 只有 wildcard、沒有 isGlobalAdmin 旗標（方式 2 單獨成立） */
const WILDCARD_ONLY = {
  roles: [{ permissions: ['*'] }],
}

/** 只有 isGlobalAdmin、權限陣列為空（方式 1 單獨成立） */
const FLAG_ONLY = {
  isGlobalAdmin: true,
  roles: [{ permissions: [] as string[] }],
}

const REVIEWER = {
  isGlobalAdmin: false,
  roles: [{ permissions: ['INVOICE_VIEW', 'INVOICE_REVIEW'] }],
}

const VIEWER = {
  isGlobalAdmin: false,
  roles: [{ permissions: ['INVOICE_VIEW'] }],
}

describe('FIX-134 sessionHasPermission', () => {
  describe('全域管理員（三套方式各自成立）', () => {
    it('should grant any permission when isGlobalAdmin and wildcard both hold', () => {
      expect(sessionHasPermission(GLOBAL_ADMIN, 'INVOICE_REVIEW')).toBe(true)
      expect(sessionHasPermission(GLOBAL_ADMIN, 'AUDIT_VIEW')).toBe(true)
      expect(sessionHasPermission(GLOBAL_ADMIN, 'ANY_FUTURE_PERMISSION')).toBe(true)
    })

    it('should grant any permission from the wildcard alone', () => {
      expect(sessionHasPermission(WILDCARD_ONLY, 'INVOICE_REVIEW')).toBe(true)
      expect(sessionHasPermission(WILDCARD_ONLY, 'AUDIT_VIEW')).toBe(true)
    })

    it('should grant any permission from isGlobalAdmin alone, even with no permissions listed', () => {
      expect(sessionHasPermission(FLAG_ONLY, 'INVOICE_REVIEW')).toBe(true)
    })
  })

  describe('一般帳號', () => {
    it('should grant a permission that is listed explicitly', () => {
      expect(sessionHasPermission(REVIEWER, 'INVOICE_REVIEW')).toBe(true)
      expect(sessionHasPermission(REVIEWER, 'INVOICE_VIEW')).toBe(true)
    })

    // 回歸保護：加入 wildcard 支援不可放寬成任何人都通過
    it('should deny a permission that is not listed', () => {
      expect(sessionHasPermission(VIEWER, 'INVOICE_REVIEW')).toBe(false)
      expect(sessionHasPermission(REVIEWER, 'AUDIT_VIEW')).toBe(false)
    })

    it('should deny when the role list is empty', () => {
      expect(sessionHasPermission({ roles: [] }, 'INVOICE_VIEW')).toBe(false)
    })
  })

  describe('缺值安全性', () => {
    it('should return false without throwing for undefined / null user', () => {
      expect(sessionHasPermission(undefined, 'INVOICE_VIEW')).toBe(false)
      expect(sessionHasPermission(null, 'INVOICE_VIEW')).toBe(false)
    })

    it('should return false without throwing when roles is absent', () => {
      expect(sessionHasPermission({}, 'INVOICE_VIEW')).toBe(false)
    })
  })

  describe('多角色聚合', () => {
    it('should grant a permission held by any one of several roles', () => {
      const user = {
        roles: [{ permissions: ['INVOICE_VIEW'] }, { permissions: ['AUDIT_VIEW'] }],
      }

      expect(sessionHasPermission(user, 'AUDIT_VIEW')).toBe(true)
      expect(sessionHasPermission(user, 'INVOICE_VIEW')).toBe(true)
      expect(sessionHasPermission(user, 'RULE_EDIT')).toBe(false)
    })
  })
})

describe('FIX-134 sessionHasAnyPermission', () => {
  it('should grant when at least one required permission is held', () => {
    expect(sessionHasAnyPermission(VIEWER, ['INVOICE_REVIEW', 'INVOICE_VIEW'])).toBe(true)
  })

  it('should deny when none of the required permissions is held', () => {
    expect(sessionHasAnyPermission(VIEWER, ['INVOICE_REVIEW', 'AUDIT_VIEW'])).toBe(false)
  })

  it('should grant everything for a global admin', () => {
    expect(sessionHasAnyPermission(GLOBAL_ADMIN, ['AUDIT_VIEW'])).toBe(true)
  })

  it('should deny for an empty requirement list (nothing can be satisfied)', () => {
    expect(sessionHasAnyPermission(GLOBAL_ADMIN, [])).toBe(false)
  })
})

describe('FIX-134 sessionHasAllPermissions', () => {
  it('should grant when every required permission is held', () => {
    expect(sessionHasAllPermissions(REVIEWER, ['INVOICE_VIEW', 'INVOICE_REVIEW'])).toBe(true)
  })

  it('should deny when one required permission is missing', () => {
    expect(sessionHasAllPermissions(VIEWER, ['INVOICE_VIEW', 'INVOICE_REVIEW'])).toBe(false)
  })

  it('should grant everything for a global admin', () => {
    expect(sessionHasAllPermissions(GLOBAL_ADMIN, ['AUDIT_VIEW', 'RULE_EDIT'])).toBe(true)
  })

  it('should grant for an empty requirement list (Array.every semantics)', () => {
    expect(sessionHasAllPermissions(VIEWER, [])).toBe(true)
  })
})

describe('FIX-134 sessionHasAuditAccess（BUG-3：取代角色名稱比對）', () => {
  /** 實際的 Auditor 角色權限（src/types/role-permissions.ts）*/
  const AUDITOR = {
    isGlobalAdmin: false,
    roles: [
      {
        name: 'Auditor',
        permissions: ['report:view', 'report:export', 'audit:view', 'audit:export'],
      },
    ],
  }

  it('should grant access to the Auditor role via its audit permissions', () => {
    expect(sessionHasAuditAccess(AUDITOR)).toBe(true)
  })

  it('should grant access to a global admin', () => {
    expect(sessionHasAuditAccess(GLOBAL_ADMIN)).toBe(true)
    expect(sessionHasAuditAccess(WILDCARD_ONLY)).toBe(true)
    expect(sessionHasAuditAccess(FLAG_ONLY)).toBe(true)
  })

  it('should grant access with audit:view alone', () => {
    expect(sessionHasAuditAccess({ roles: [{ permissions: ['audit:view'] }] })).toBe(true)
  })

  it('should deny access to a role without audit permissions', () => {
    expect(sessionHasAuditAccess(REVIEWER)).toBe(false)
    expect(sessionHasAuditAccess(VIEWER)).toBe(false)
  })

  it('should deny access for undefined user', () => {
    expect(sessionHasAuditAccess(undefined)).toBe(false)
  })

  // 這正是 BUG-3：舊寫法比對 role.name ∈ ['AUDITOR','GLOBAL_ADMIN']，
  // 但實際角色名是 'Auditor' 與 'System Admin' —— 兩者皆對不上。
  it('should not depend on the role name at all', () => {
    const oddlyNamedAuditor = {
      roles: [{ name: '完全不同的名稱', permissions: ['audit:view'] }],
    }

    expect(sessionHasAuditAccess(oddlyNamedAuditor)).toBe(true)
  })
})

describe('FIX-134 permissionListHas', () => {
  it('should honour the wildcard in a flattened permission list', () => {
    expect(permissionListHas(['*'], 'INVOICE_REVIEW')).toBe(true)
  })

  it('should match an explicitly listed permission', () => {
    expect(permissionListHas(['INVOICE_VIEW'], 'INVOICE_VIEW')).toBe(true)
  })

  it('should deny a permission that is absent', () => {
    expect(permissionListHas(['INVOICE_VIEW'], 'INVOICE_REVIEW')).toBe(false)
    expect(permissionListHas([], 'INVOICE_VIEW')).toBe(false)
  })
})
