/**
 * @fileoverview Production Essential Seed — 系統角色權限定義（純資料，零副作用）
 * @module prisma/seed-prod-essential.roles
 * @since FIX-139 - 2026-07-28
 * @lastModified 2026-07-28
 *
 * 為何獨立成檔（兩個理由，缺一不可）：
 *
 * 1. **可被測試安全 import** —— `seed-prod-essential.ts` 在 module load 時就建立
 *    `Pool` / `PrismaClient` 並於檔尾直接呼叫 `main()`，測試 import 它會真的連 DB
 *    並執行 seed。權限值抽到本檔（無 import、無副作用）後，防漂移測試
 *    (`tests/unit/prisma/essential-seed-permissions.test.ts`) 才能比對兩份定義。
 *
 * 2. **維持 tsc 輸出路徑** —— Dockerfile 以「裸 tsc 單檔編譯」產生 seed 的 JS
 *    （無 `--project`，故 `@/*` alias 解析不到；這是 essential seed 不 import `src/`
 *    的真正原因）。未指定 `--rootDir` 時 tsc 取所有輸入檔的 common root，
 *    **若 import `../src/**` 則 common root 上移至專案根**，輸出會變成
 *    `prisma/dist/prisma/seed-prod-essential.js`，而 `docker-entrypoint.sh` 執行的是
 *    `prisma/dist/seed-prod-essential.js` —— 在 `set -e` 下該步驟失敗即容器起不來。
 *    本檔與 seed 主檔同在 `prisma/` 下，common root 維持 `prisma/`，輸出路徑不變。
 *
 * ⚠️ 本檔的權限字串**必須與 `src/types/permissions.ts` 的 `PERMISSIONS` 常量逐字相符**。
 *    這是刻意接受的「兩份定義」（換取 seed 對 `src/` 零依賴），由上述防漂移測試
 *    在 CI 擋住漂移 —— 改動任一邊而未同步，測試即紅。
 *
 * @see claudedocs/4-changes/bug-fixes/FIX-139-essential-seed-placeholder-permissions.md
 */

/**
 * 單一系統角色的 seed 定義
 */
export interface RoleSeed {
  name: string
  description: string
  permissions: string[]
}

/**
 * 系統角色定義
 *
 * 7 個系統角色，覆蓋 CLAUDE.md 中提及的職責分工：
 * - System Admin: 最高權限（與現有 codebase ROLE_NAMES 對齊）
 * - Super User: 規則 / Forwarder 配置管理
 * - Regional Manager: 跨城市管理
 * - City Manager: 單城市管理
 * - Data Processor: 預設角色（基礎發票處理）
 * - Auditor: 只讀審計
 * - System: 系統內部自動操作（給 system-user-prod 使用）
 *
 * 權限值來源與順序均對齊 `src/types/role-permissions.ts` 的 `ROLE_PERMISSIONS`
 * （FIX-139 前為點號分隔的佔位值，與程式碼常量的冒號格式永遠比不中）。
 */
export const ROLES: RoleSeed[] = [
  {
    name: 'System Admin',
    description: 'System administrator with full access to all features',
    // wildcard —— 語意等價於 ROLE_PERMISSIONS 的 Object.values(PERMISSIONS) 全展開，
    // 但「未來新增權限自動涵蓋」。`sessionHasPermission` 顯式認得此字面字串（FIX-134）。
    permissions: ['*'],
  },
  {
    name: 'Super User',
    description: 'Power user with rule management and Forwarder configuration access',
    permissions: [
      'invoice:view',
      'invoice:create',
      'invoice:review',
      'invoice:approve',
      'report:view',
      'report:export',
      'rule:view',
      'rule:manage',
      'rule:approve',
      'forwarder:view',
      'forwarder:manage',
    ],
  },
  {
    name: 'Regional Manager',
    description: 'Manager with multi-city access within a region',
    permissions: [
      'invoice:view',
      'invoice:create',
      'invoice:review',
      'invoice:approve',
      'report:view',
      'report:export',
      'user:view',
      'user:manage:region',
      'forwarder:view',
    ],
  },
  {
    name: 'City Manager',
    description: 'Manager with single-city scope (users + documents)',
    permissions: [
      'invoice:view',
      'invoice:create',
      'invoice:review',
      'invoice:approve',
      'report:view',
      'report:export',
      'user:view',
      'user:manage:city',
      'forwarder:view',
    ],
  },
  {
    name: 'Data Processor',
    description: 'Default role for new users — basic invoice processing and review',
    permissions: ['invoice:view', 'invoice:create', 'invoice:review'],
  },
  {
    name: 'Auditor',
    description: 'Read-only auditor with audit log and report access',
    permissions: ['report:view', 'report:export', 'audit:view', 'audit:export'],
  },
  {
    name: 'System',
    description: 'System-internal role for automated operations (system-user-prod)',
    // essential-seed-only 角色：不在 ROLE_NAMES（該常量只含 6 個可指派給人的角色），
    // 故 PERMISSIONS 常量亦無對應項。保留專屬權限字串，僅統一為冒號分隔命名慣例。
    permissions: ['system:internal'],
  },
]
