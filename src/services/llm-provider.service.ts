/**
 * @fileoverview LLM Provider 管理服務（Epic 23 - Story 23.2）
 * @description
 *   後台多 LLM provider 的 CRUD 資料服務，承接 Story 23.1 的 `LlmProvider`/`LlmModel` 資料層。
 *   H4 安全要點（三輪審視 §11）：
 *     - **加密寫入**：`apiKey` 明文經 `encryptConfigValue`（aes-256-gcm / `CONFIG_ENCRYPTION_KEY`）加密落庫。
 *     - **遮罩讀取**：回傳一律用 `LlmProviderMasked`，**永不**帶 `apiKeyEnc` / 明文；只給 `hasApiKey`
 *       與（單筆檢視才有的）末 4 碼預覽 `apiKeyPreview`。list() 不解密（縮小明文暴露面）。
 *     - **審計**：create/update/delete 掛 `AuditLog`（`resourceType=LlmProvider`），`changes` 快照
 *       **只存遮罩值**（`hasApiKey` 布林，永不存明文/密文）。
 *     - **isDefault 排他**：走 transaction 清除其他 default（§4 應用層唯一性）。
 *
 *   ⚠️ 本服務不負責授權（globalAdmin / SSRF baseUrl 護欄由 API 層把關）；連線測試（testConnection）
 *      與模型子資源隨其 API route 於 step 2 實作。
 *
 * @module src/services/llm-provider.service
 * @since Epic 23 - Story 23.2
 * @lastModified 2026-07-10
 *
 * @related
 *   - src/lib/config-encryption.ts - GCM 加解密（共用模組）
 *   - src/lib/validations/llm-provider.schema.ts - 輸入驗證
 *   - src/services/audit-log.service.ts - 審計寫入
 *   - src/services/llm/llm-gateway.service.ts - 解密憑證消費端（fail-closed）
 */

import { Prisma } from '@prisma/client';
import type { LlmModel, LlmProvider, LlmProviderType } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { encryptConfigValue, decryptConfigValue } from '@/lib/config-encryption';
import { auditLogService } from '@/services/audit-log.service';
import type { AuditChanges } from '@/types/audit';
import type {
  CreateLlmModelInput,
  CreateLlmProviderInput,
  UpdateLlmProviderInput,
} from '@/lib/validations/llm-provider.schema';

// ============================================================================
// 常數
// ============================================================================

/** 審計 resourceType（供查詢 provider / model 變更歷史） */
const AUDIT_RESOURCE_PROVIDER = 'LlmProvider';
const AUDIT_RESOURCE_MODEL = 'LlmModel';

/** 遮罩前綴（不洩漏長度／內容） */
const MASK_PREFIX = '••••';

/** Azure 連線測試預設 api-version（對齊 gateway） */
const DEFAULT_AZURE_API_VERSION = '2024-12-01-preview';

/** 連線測試逾時（毫秒） */
const TEST_TIMEOUT_MS = 15_000;

// ============================================================================
// 型別
// ============================================================================

/** 遮罩後的 provider（對外回傳唯一形狀；永不含 `apiKeyEnc` / 明文） */
export interface LlmProviderMasked {
  id: string;
  name: string;
  providerType: LlmProviderType;
  baseUrl: string | null;
  apiVersion: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  allowSensitiveData: boolean;
  keyVersion: number;
  extraConfig: Prisma.JsonValue;
  /** 是否已設定 API key（不洩漏內容） */
  hasApiKey: boolean;
  /** 末 4 碼預覽（`••••1234`）；僅單筆檢視提供，list 為 `null`（縮小解密暴露面） */
  apiKeyPreview: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 審計行為者（由 API 層自 session 帶入） */
export interface LlmProviderAuditActor {
  userId: string;
  userName: string;
  userEmail?: string;
}

/** 連線測試結果 */
export interface TestConnectionResult {
  /** 測試是否通過 */
  success: boolean;
  /** 該 provider 型別目前是否支援完整測試（非 Azure gateway 未接 → false，見 Story 23.3） */
  supported: boolean;
  message: string;
  statusCode?: number;
}

/** 模型對外形狀（無憑證，直接回傳） */
export interface LlmModelPublic {
  id: string;
  providerId: string;
  modelKey: string;
  label: string;
  capability: Prisma.JsonValue;
  pricing: Prisma.JsonValue;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// 錯誤
// ============================================================================

/** Provider 服務錯誤（未知 id、名稱重複等；API 層映射為 RFC 7807） */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

// ============================================================================
// 服務
// ============================================================================

export class LlmProviderService {
  /** 列出全部 provider（default 優先、名稱升序）；遮罩、**不解密**（list 不含 preview） */
  async list(): Promise<LlmProviderMasked[]> {
    const rows = await prisma.llmProvider.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return rows.map((p) => this.toMasked(p, false));
  }

  /** 取單一 provider（遮罩，含末 4 碼預覽）；不存在回 `null` */
  async get(id: string): Promise<LlmProviderMasked | null> {
    const p = await prisma.llmProvider.findUnique({ where: { id } });
    return p ? this.toMasked(p, true) : null;
  }

  /** 建立 provider（加密 apiKey、isDefault 排他、審計 CREATE） */
  async create(
    input: CreateLlmProviderInput,
    actor: LlmProviderAuditActor,
  ): Promise<LlmProviderMasked> {
    const apiKeyEnc = input.apiKey ? encryptConfigValue(input.apiKey) : null;

    let created: LlmProvider;
    try {
      created = await prisma.$transaction(async (tx) => {
        if (input.isDefault) await this.clearDefault(tx);
        return tx.llmProvider.create({
          data: {
            name: input.name,
            providerType: input.providerType,
            baseUrl: input.baseUrl,
            apiVersion: input.apiVersion,
            apiKeyEnc,
            isEncrypted: apiKeyEnc !== null,
            isEnabled: input.isEnabled,
            isDefault: input.isDefault,
            allowSensitiveData: input.allowSensitiveData,
            extraConfig: (input.extraConfig ?? undefined) as
              | Prisma.InputJsonValue
              | undefined,
            updatedBy: actor.userId,
          },
        });
      });
    } catch (e) {
      throw this.mapWriteError(e);
    }

    await this.audit('CREATE', created, actor, { after: this.auditSnapshot(created) });
    return this.toMasked(created, true);
  }

  /** 更新 provider（apiKey 有提供才 re-encrypt；isDefault=true 排他；審計 UPDATE） */
  async update(
    id: string,
    input: UpdateLlmProviderInput,
    actor: LlmProviderAuditActor,
  ): Promise<LlmProviderMasked> {
    const existing = await prisma.llmProvider.findUnique({ where: { id } });
    if (!existing) {
      throw new LlmProviderError(`未知 provider: ${id}`, 'PROVIDER_NOT_FOUND');
    }

    const data: Prisma.LlmProviderUpdateInput = { updatedBy: actor.userId };
    if (input.name !== undefined) data.name = input.name;
    if (input.providerType !== undefined) data.providerType = input.providerType;
    if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl; // null 清空
    if (input.apiVersion !== undefined) data.apiVersion = input.apiVersion;
    if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
    if (input.isDefault !== undefined) data.isDefault = input.isDefault;
    if (input.allowSensitiveData !== undefined) {
      data.allowSensitiveData = input.allowSensitiveData;
    }
    if (input.extraConfig !== undefined) {
      data.extraConfig =
        input.extraConfig === null
          ? Prisma.DbNull
          : (input.extraConfig as Prisma.InputJsonValue);
    }
    if (input.apiKey !== undefined) {
      data.apiKeyEnc = encryptConfigValue(input.apiKey);
      data.isEncrypted = true;
    }

    let updated: LlmProvider;
    try {
      updated = await prisma.$transaction(async (tx) => {
        if (input.isDefault === true) await this.clearDefault(tx, id);
        return tx.llmProvider.update({ where: { id }, data });
      });
    } catch (e) {
      throw this.mapWriteError(e);
    }

    await this.audit('UPDATE', updated, actor, {
      before: this.auditSnapshot(existing),
      after: this.auditSnapshot(updated),
    });
    return this.toMasked(updated, true);
  }

  /** 刪除 provider（cascade 移除其模型）；審計 DELETE */
  async remove(id: string, actor: LlmProviderAuditActor): Promise<void> {
    const existing = await prisma.llmProvider.findUnique({ where: { id } });
    if (!existing) {
      throw new LlmProviderError(`未知 provider: ${id}`, 'PROVIDER_NOT_FOUND');
    }
    await prisma.llmProvider.delete({ where: { id } });
    await this.audit('DELETE', existing, actor, {
      before: this.auditSnapshot(existing),
    });
  }

  /**
   * 連線測試（審計 READ）。Azure：以解密憑證探測 `{baseUrl}/openai/models`；
   * 非 Azure：gateway 尚未接 native provider（Story 23.3）→ 回 `supported:false`、不實測。
   * @remarks 憑證解密走 fail-closed（`decryptConfigValue`）；缺憑證回明確訊息、不拋。
   */
  async testConnection(
    id: string,
    actor: LlmProviderAuditActor,
  ): Promise<TestConnectionResult> {
    const provider = await prisma.llmProvider.findUnique({ where: { id } });
    if (!provider) {
      throw new LlmProviderError(`未知 provider: ${id}`, 'PROVIDER_NOT_FOUND');
    }

    const result = await this.probe(provider);
    await this.writeAuditEntry({
      action: 'READ',
      resourceType: AUDIT_RESOURCE_PROVIDER,
      resourceId: provider.id,
      resourceName: provider.name,
      actor,
      metadata: {
        operation: 'testConnection',
        success: result.success,
        supported: result.supported,
        statusCode: result.statusCode,
      },
    });
    return result;
  }

  /** 列出某 provider 的模型（無憑證，直接回傳） */
  async listModels(providerId: string): Promise<LlmModelPublic[]> {
    const provider = await prisma.llmProvider.findUnique({
      where: { id: providerId },
      select: { id: true },
    });
    if (!provider) {
      throw new LlmProviderError(`未知 provider: ${providerId}`, 'PROVIDER_NOT_FOUND');
    }
    const models = await prisma.llmModel.findMany({
      where: { providerId },
      orderBy: { label: 'asc' },
    });
    return models.map((m) => this.toModelPublic(m));
  }

  /** 於某 provider 下建立模型（審計 CREATE resourceType=LlmModel） */
  async createModel(
    providerId: string,
    input: CreateLlmModelInput,
    actor: LlmProviderAuditActor,
  ): Promise<LlmModelPublic> {
    const provider = await prisma.llmProvider.findUnique({
      where: { id: providerId },
      select: { id: true },
    });
    if (!provider) {
      throw new LlmProviderError(`未知 provider: ${providerId}`, 'PROVIDER_NOT_FOUND');
    }

    let created: LlmModel;
    try {
      created = await prisma.llmModel.create({
        data: {
          providerId,
          modelKey: input.modelKey,
          label: input.label,
          capability: input.capability as Prisma.InputJsonValue,
          pricing: (input.pricing ?? undefined) as Prisma.InputJsonValue | undefined,
          isEnabled: input.isEnabled,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new LlmProviderError(
          '此 provider 下已存在相同 modelKey',
          'DUPLICATE_MODEL_KEY',
        );
      }
      throw e instanceof Error ? e : new Error(String(e));
    }

    await this.writeAuditEntry({
      action: 'CREATE',
      resourceType: AUDIT_RESOURCE_MODEL,
      resourceId: created.id,
      resourceName: created.label,
      actor,
      changes: { after: { providerId, modelKey: created.modelKey, label: created.label } },
    });
    return this.toModelPublic(created);
  }

  // --------------------------------------------------------------------------
  // 內部
  // --------------------------------------------------------------------------

  /** LlmModel → 對外形狀 */
  private toModelPublic(m: LlmModel): LlmModelPublic {
    return {
      id: m.id,
      providerId: m.providerId,
      modelKey: m.modelKey,
      label: m.label,
      capability: m.capability,
      pricing: m.pricing,
      isEnabled: m.isEnabled,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  /** 實際連線探測（Azure：models 端點；非 Azure：未支援） */
  private async probe(provider: LlmProvider): Promise<TestConnectionResult> {
    const apiKey = this.resolveTestApiKey(provider);
    if (!apiKey) {
      return { success: false, supported: true, message: '缺少 API 憑證' };
    }
    if (provider.providerType !== 'AZURE_OPENAI') {
      return {
        success: false,
        supported: false,
        message: '完整連線測試待 Story 23.3（尚未接入 native provider）',
      };
    }

    const base = (provider.baseUrl ?? process.env.AZURE_OPENAI_ENDPOINT ?? '').replace(
      /\/+$/,
      '',
    );
    if (!base) {
      return { success: false, supported: true, message: '缺少 baseUrl / endpoint' };
    }
    const apiVersion = provider.apiVersion ?? DEFAULT_AZURE_API_VERSION;
    try {
      const res = await fetch(`${base}/openai/models?api-version=${apiVersion}`, {
        method: 'GET',
        headers: { 'api-key': apiKey },
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      return {
        success: res.ok,
        supported: true,
        statusCode: res.status,
        message: res.ok ? '連線成功' : `連線失敗（HTTP ${res.status}）`,
      };
    } catch (e) {
      return {
        success: false,
        supported: true,
        message: `連線失敗：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /** 取測試用憑證：加密則 fail-closed 解密；Azure 無憑證時退回 env */
  private resolveTestApiKey(provider: LlmProvider): string | undefined {
    if (provider.apiKeyEnc) {
      return provider.isEncrypted
        ? decryptConfigValue(provider.apiKeyEnc)
        : provider.apiKeyEnc;
    }
    if (provider.providerType === 'AZURE_OPENAI') {
      return process.env.AZURE_OPENAI_API_KEY;
    }
    return undefined;
  }

  /** 清除其他 provider 的 isDefault（transaction 內，保證應用層唯一性） */
  private async clearDefault(
    tx: Prisma.TransactionClient,
    exceptId?: string,
  ): Promise<void> {
    await tx.llmProvider.updateMany({
      where: { isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { isDefault: false },
    });
  }

  /** DB → 遮罩形狀（永不含憑證）；`includePreview` 時才解密取末 4 碼 */
  private toMasked(p: LlmProvider, includePreview: boolean): LlmProviderMasked {
    return {
      id: p.id,
      name: p.name,
      providerType: p.providerType,
      baseUrl: p.baseUrl,
      apiVersion: p.apiVersion,
      isEnabled: p.isEnabled,
      isDefault: p.isDefault,
      allowSensitiveData: p.allowSensitiveData,
      keyVersion: p.keyVersion,
      extraConfig: p.extraConfig,
      hasApiKey: p.apiKeyEnc !== null,
      apiKeyPreview: includePreview ? this.buildKeyPreview(p) : null,
      updatedBy: p.updatedBy,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  /** 末 4 碼預覽（best-effort）；解密失敗仍不洩漏，回 `••••` 標示有 key */
  private buildKeyPreview(p: {
    apiKeyEnc: string | null;
    isEncrypted: boolean;
  }): string | null {
    if (!p.apiKeyEnc) return null;
    try {
      const plain = p.isEncrypted ? decryptConfigValue(p.apiKeyEnc) : p.apiKeyEnc;
      const tail = plain.slice(-4);
      return tail ? `${MASK_PREFIX}${tail}` : MASK_PREFIX;
    } catch {
      return MASK_PREFIX;
    }
  }

  /** 遮罩審計快照（**永不**含明文/密文，只記 `hasApiKey` 布林） */
  private auditSnapshot(p: LlmProvider): Record<string, unknown> {
    return {
      name: p.name,
      providerType: p.providerType,
      baseUrl: p.baseUrl,
      apiVersion: p.apiVersion,
      isEnabled: p.isEnabled,
      isDefault: p.isDefault,
      allowSensitiveData: p.allowSensitiveData,
      keyVersion: p.keyVersion,
      hasApiKey: p.apiKeyEnc !== null,
    };
  }

  /** 寫 provider 審計（CREATE/UPDATE/DELETE，含遮罩前後快照） */
  private async audit(
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    provider: LlmProvider,
    actor: LlmProviderAuditActor,
    changes: AuditChanges,
  ): Promise<void> {
    await this.writeAuditEntry({
      action,
      resourceType: AUDIT_RESOURCE_PROVIDER,
      resourceId: provider.id,
      resourceName: provider.name,
      actor,
      changes,
    });
  }

  /** 通用審計寫入（auditLogService.log 內部已 fail-safe，不會拋回主流程） */
  private async writeAuditEntry(params: {
    action: 'CREATE' | 'UPDATE' | 'DELETE' | 'READ';
    resourceType: string;
    resourceId: string;
    resourceName: string;
    actor: LlmProviderAuditActor;
    changes?: AuditChanges;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await auditLogService.log({
      userId: params.actor.userId,
      userName: params.actor.userName,
      userEmail: params.actor.userEmail,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      resourceName: params.resourceName,
      changes: params.changes,
      metadata: params.metadata,
      status: 'SUCCESS',
    });
  }

  /** 唯一名稱衝突（P2002）→ 明確錯誤；其餘原樣拋出 */
  private mapWriteError(e: unknown): Error {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new LlmProviderError('Provider 名稱已存在', 'DUPLICATE_NAME');
    }
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** 單例 */
export const llmProviderService = new LlmProviderService();
