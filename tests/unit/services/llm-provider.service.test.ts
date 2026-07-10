/**
 * @fileoverview LlmProviderService 單元測試（Epic 23 - Story 23.2 step 1）
 * @description
 *   驗證 provider 資料服務契約（全程 mock，無 DB/無網路）：
 *   - 加密寫入：apiKey 經 encryptConfigValue 加密；省略則 apiKeyEnc=null。
 *   - 遮罩讀取：回傳永不含 apiKeyEnc/明文；list 不解密（無 preview）、get 才有末 4 碼。
 *   - isDefault 排他：transaction 內清除其他 default。
 *   - 審計：create/update/delete 寫 AuditLog，changes 快照只存遮罩值（無明文/密文）。
 *   - 錯誤：未知 id → PROVIDER_NOT_FOUND；名稱重複（P2002）→ DUPLICATE_NAME。
 *
 * @module tests/unit/services/llm-provider.service.test
 * @since Epic 23 - Story 23.2
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { LlmProvider } from '@prisma/client';

// Mock Prisma：tx 與 prisma 共用同一 llmProvider mock（$transaction 回傳 callback 結果）
vi.mock('@/lib/prisma', () => {
  const llmProvider = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  };
  const llmModel = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return {
    prisma: {
      llmProvider,
      llmModel,
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({ llmProvider })),
    },
  };
});

// Mock 加解密：可逆的假實作，方便斷言
vi.mock('@/lib/config-encryption', () => ({
  encryptConfigValue: vi.fn((v: string) => `enc(${v})`),
  decryptConfigValue: vi.fn((v: string) => v.replace(/^enc\(/, '').replace(/\)$/, '')),
}));

// Mock 審計
vi.mock('@/services/audit-log.service', () => ({
  auditLogService: { log: vi.fn() },
}));

import { prisma } from '@/lib/prisma';
import { encryptConfigValue, decryptConfigValue } from '@/lib/config-encryption';
import { auditLogService } from '@/services/audit-log.service';
import { llmProviderService } from '@/services/llm-provider.service';

const actor = { userId: 'u-1', userName: 'Admin' };

/** 建一筆 DB 形狀的 LlmProvider（apiKeyEnc 用可逆假加密） */
function dbProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'p-1',
    name: 'Azure OpenAI',
    providerType: 'AZURE_OPENAI',
    baseUrl: 'https://x.openai.azure.com',
    apiVersion: '2024-12-01-preview',
    apiKeyEnc: 'enc(secret-key-1234)',
    isEncrypted: true,
    keyVersion: 1,
    isEnabled: true,
    isDefault: true,
    allowSensitiveData: false,
    extraConfig: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    updatedBy: 'u-1',
    ...overrides,
  } as LlmProvider;
}

/** 取 mock 呼叫參數（放寬型別，避開 Prisma input union 摩擦） */
function createArg() {
  return vi.mocked(prisma.llmProvider.create).mock.calls[0][0] as {
    data: Record<string, unknown>;
  };
}
function updateArg() {
  return vi.mocked(prisma.llmProvider.update).mock.calls[0][0] as {
    data: Record<string, unknown>;
  };
}
function lastAudit() {
  const calls = vi.mocked(auditLogService.log).mock.calls;
  return calls[calls.length - 1][0];
}

describe('LlmProviderService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should encrypt apiKey, apply default exclusivity, audit CREATE, and return masked', async () => {
      vi.mocked(prisma.llmProvider.create).mockResolvedValue(dbProvider() as never);

      const r = await llmProviderService.create(
        {
          name: 'Azure OpenAI',
          providerType: 'AZURE_OPENAI',
          apiKey: 'secret-key-1234',
          isEnabled: true,
          isDefault: true,
          allowSensitiveData: false,
        },
        actor,
      );

      // 加密寫入
      expect(encryptConfigValue).toHaveBeenCalledWith('secret-key-1234');
      expect(createArg().data.apiKeyEnc).toBe('enc(secret-key-1234)');
      expect(createArg().data.isEncrypted).toBe(true);

      // isDefault 排他：清除其他 default
      expect(prisma.llmProvider.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isDefault: true }, data: { isDefault: false } }),
      );

      // 遮罩輸出：不含 apiKeyEnc、hasApiKey=true、含末 4 碼
      expect((r as Record<string, unknown>).apiKeyEnc).toBeUndefined();
      expect(r.hasApiKey).toBe(true);
      expect(r.apiKeyPreview).toBe('••••1234');

      // 審計 CREATE + 遮罩快照（永不含明文/密文）
      const audit = lastAudit();
      expect(audit.action).toBe('CREATE');
      expect(audit.resourceType).toBe('LlmProvider');
      expect(audit.changes?.after?.hasApiKey).toBe(true);
      const auditJson = JSON.stringify(audit.changes);
      expect(auditJson).not.toContain('secret-key-1234');
      expect(auditJson).not.toContain('enc(');
    });

    it('should store null apiKeyEnc and skip encryption when apiKey is omitted', async () => {
      vi.mocked(prisma.llmProvider.create).mockResolvedValue(
        dbProvider({ apiKeyEnc: null, isEncrypted: false, isDefault: false }) as never,
      );

      const r = await llmProviderService.create(
        {
          name: 'OpenAI',
          providerType: 'OPENAI',
          isEnabled: true,
          isDefault: false,
          allowSensitiveData: false,
        },
        actor,
      );

      expect(encryptConfigValue).not.toHaveBeenCalled();
      expect(prisma.llmProvider.updateMany).not.toHaveBeenCalled();
      expect(createArg().data.apiKeyEnc).toBeNull();
      expect(createArg().data.isEncrypted).toBe(false);
      expect(r.hasApiKey).toBe(false);
      expect(r.apiKeyPreview).toBeNull();
    });

    it('should map P2002 to DUPLICATE_NAME', async () => {
      vi.mocked(prisma.llmProvider.create).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        llmProviderService.create(
          {
            name: 'dup',
            providerType: 'OPENAI',
            isEnabled: true,
            isDefault: false,
            allowSensitiveData: false,
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
    });
  });

  describe('list / get (masking)', () => {
    it('should return masked providers without preview and without decrypting on list', async () => {
      vi.mocked(prisma.llmProvider.findMany).mockResolvedValue([dbProvider()] as never);

      const r = await llmProviderService.list();

      expect(r[0].hasApiKey).toBe(true);
      expect(r[0].apiKeyPreview).toBeNull(); // list 不給 preview
      expect(decryptConfigValue).not.toHaveBeenCalled(); // list 不解密
      expect((r[0] as Record<string, unknown>).apiKeyEnc).toBeUndefined();
    });

    it('should include the last-4 preview on single get (decrypts)', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(dbProvider() as never);

      const r = await llmProviderService.get('p-1');

      expect(r?.apiKeyPreview).toBe('••••1234');
      expect(decryptConfigValue).toHaveBeenCalledWith('enc(secret-key-1234)');
    });

    it('should return null for unknown id on get', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(null as never);
      expect(await llmProviderService.get('nope')).toBeNull();
    });
  });

  describe('update', () => {
    it('should re-encrypt apiKey and audit before/after when apiKey provided', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(dbProvider() as never);
      vi.mocked(prisma.llmProvider.update).mockResolvedValue(
        dbProvider({ apiKeyEnc: 'enc(new-key-9999)' }) as never,
      );

      const r = await llmProviderService.update('p-1', { apiKey: 'new-key-9999' }, actor);

      expect(encryptConfigValue).toHaveBeenCalledWith('new-key-9999');
      expect(updateArg().data.apiKeyEnc).toBe('enc(new-key-9999)');
      expect(updateArg().data.isEncrypted).toBe(true);

      const audit = lastAudit();
      expect(audit.action).toBe('UPDATE');
      expect(audit.changes?.before).toBeDefined();
      expect(audit.changes?.after).toBeDefined();
      expect(r.hasApiKey).toBe(true);
    });

    it('should not re-encrypt when apiKey is omitted', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(dbProvider() as never);
      vi.mocked(prisma.llmProvider.update).mockResolvedValue(
        dbProvider({ isEnabled: false }) as never,
      );

      await llmProviderService.update('p-1', { isEnabled: false }, actor);

      expect(encryptConfigValue).not.toHaveBeenCalled();
      expect(updateArg().data.apiKeyEnc).toBeUndefined();
    });

    it('should clear other defaults when setting isDefault true', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(
        dbProvider({ isDefault: false }) as never,
      );
      vi.mocked(prisma.llmProvider.update).mockResolvedValue(
        dbProvider({ isDefault: true }) as never,
      );

      await llmProviderService.update('p-1', { isDefault: true }, actor);

      expect(prisma.llmProvider.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isDefault: true, id: { not: 'p-1' } },
          data: { isDefault: false },
        }),
      );
    });

    it('should throw PROVIDER_NOT_FOUND for unknown id', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(null as never);
      await expect(
        llmProviderService.update('nope', { isEnabled: false }, actor),
      ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    });
  });

  describe('remove', () => {
    it('should delete and audit DELETE with masked before snapshot', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(dbProvider() as never);

      await llmProviderService.remove('p-1', actor);

      expect(prisma.llmProvider.delete).toHaveBeenCalledWith({ where: { id: 'p-1' } });
      const audit = lastAudit();
      expect(audit.action).toBe('DELETE');
      expect(audit.changes?.before).toBeDefined();
      expect(JSON.stringify(audit.changes)).not.toContain('enc(');
    });

    it('should throw PROVIDER_NOT_FOUND for unknown id', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(null as never);
      await expect(llmProviderService.remove('nope', actor)).rejects.toMatchObject({
        code: 'PROVIDER_NOT_FOUND',
      });
    });
  });

  describe('testConnection', () => {
    it('should probe the Azure models endpoint, report success, and audit READ', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(dbProvider() as never);
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const r = await llmProviderService.testConnection('p-1', actor);

      expect(r).toMatchObject({ success: true, supported: true, statusCode: 200 });
      const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(String(url)).toContain('/openai/models?api-version=');
      expect(init.headers['api-key']).toBe('secret-key-1234'); // 解密後憑證
      expect(lastAudit().action).toBe('READ');
      vi.unstubAllGlobals();
    });

    it('should report failure when the Azure probe is not ok', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(dbProvider() as never);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

      const r = await llmProviderService.testConnection('p-1', actor);

      expect(r.success).toBe(false);
      expect(r.statusCode).toBe(401);
      vi.unstubAllGlobals();
    });

    it('should report unsupported for a non-Azure provider without probing', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(
        dbProvider({ providerType: 'OPENAI', apiKeyEnc: 'enc(openai-key)', isEncrypted: true }) as never,
      );
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const r = await llmProviderService.testConnection('p-1', actor);

      expect(r.supported).toBe(false);
      expect(r.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('should throw PROVIDER_NOT_FOUND for unknown id', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(null as never);
      await expect(llmProviderService.testConnection('nope', actor)).rejects.toMatchObject({
        code: 'PROVIDER_NOT_FOUND',
      });
    });
  });

  describe('listModels / createModel', () => {
    function dbModel(overrides: Record<string, unknown> = {}) {
      return {
        id: 'm-1',
        providerId: 'p-1',
        modelKey: 'gpt-5.2',
        label: 'GPT-5.2',
        capability: { maxTokens: 8192 },
        pricing: null,
        isEnabled: true,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
        ...overrides,
      };
    }

    it('should list models for an existing provider', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue({ id: 'p-1' } as never);
      vi.mocked(prisma.llmModel.findMany).mockResolvedValue([dbModel()] as never);

      const r = await llmProviderService.listModels('p-1');

      expect(r).toHaveLength(1);
      expect(r[0].modelKey).toBe('gpt-5.2');
    });

    it('should throw PROVIDER_NOT_FOUND when listing models for unknown provider', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue(null as never);
      await expect(llmProviderService.listModels('nope')).rejects.toMatchObject({
        code: 'PROVIDER_NOT_FOUND',
      });
    });

    it('should create a model and audit CREATE (resourceType LlmModel)', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue({ id: 'p-1' } as never);
      vi.mocked(prisma.llmModel.create).mockResolvedValue(dbModel() as never);

      const r = await llmProviderService.createModel(
        'p-1',
        {
          modelKey: 'gpt-5.2',
          label: 'GPT-5.2',
          capability: {
            maxTokens: 8192,
            supportsTemperature: true,
            supportsJsonSchema: true,
            supportsVision: true,
          },
          isEnabled: true,
        },
        actor,
      );

      expect(r.modelKey).toBe('gpt-5.2');
      const a = lastAudit();
      expect(a.action).toBe('CREATE');
      expect(a.resourceType).toBe('LlmModel');
    });

    it('should map P2002 to DUPLICATE_MODEL_KEY on createModel', async () => {
      vi.mocked(prisma.llmProvider.findUnique).mockResolvedValue({ id: 'p-1' } as never);
      vi.mocked(prisma.llmModel.create).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        llmProviderService.createModel(
          'p-1',
          {
            modelKey: 'dup',
            label: 'Dup',
            capability: {
              maxTokens: 1,
              supportsTemperature: false,
              supportsJsonSchema: false,
              supportsVision: false,
            },
            isEnabled: true,
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: 'DUPLICATE_MODEL_KEY' });
    });
  });

  describe('updateModel / deleteModel', () => {
    function dbModel(overrides: Record<string, unknown> = {}) {
      return {
        id: 'm-1',
        providerId: 'p-1',
        modelKey: 'gpt-5.2',
        label: 'GPT-5.2',
        capability: {
          maxTokens: 8192,
          supportsTemperature: true,
          supportsJsonSchema: true,
          supportsVision: true,
        },
        pricing: null,
        isEnabled: true,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
        ...overrides,
      };
    }

    it('should update a model and audit UPDATE (resourceType LlmModel)', async () => {
      vi.mocked(prisma.llmModel.findFirst).mockResolvedValue(dbModel() as never);
      vi.mocked(prisma.llmModel.update).mockResolvedValue(
        dbModel({ label: 'GPT-5.2 (v2)', isEnabled: false }) as never,
      );

      const r = await llmProviderService.updateModel(
        'p-1',
        'm-1',
        { label: 'GPT-5.2 (v2)', isEnabled: false },
        actor,
      );

      expect(r.label).toBe('GPT-5.2 (v2)');
      expect(r.isEnabled).toBe(false);
      const a = lastAudit();
      expect(a.action).toBe('UPDATE');
      expect(a.resourceType).toBe('LlmModel');
    });

    it('should throw MODEL_NOT_FOUND when updating an unknown model', async () => {
      vi.mocked(prisma.llmModel.findFirst).mockResolvedValue(null as never);
      await expect(
        llmProviderService.updateModel('p-1', 'nope', { label: 'x' }, actor),
      ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    });

    it('should map P2002 to DUPLICATE_MODEL_KEY on updateModel', async () => {
      vi.mocked(prisma.llmModel.findFirst).mockResolvedValue(dbModel() as never);
      vi.mocked(prisma.llmModel.update).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        llmProviderService.updateModel('p-1', 'm-1', { modelKey: 'dup' }, actor),
      ).rejects.toMatchObject({ code: 'DUPLICATE_MODEL_KEY' });
    });

    it('should delete a model and audit DELETE (resourceType LlmModel)', async () => {
      vi.mocked(prisma.llmModel.findFirst).mockResolvedValue(dbModel() as never);
      vi.mocked(prisma.llmModel.delete).mockResolvedValue(dbModel() as never);

      await llmProviderService.deleteModel('p-1', 'm-1', actor);

      expect(prisma.llmModel.delete).toHaveBeenCalledWith({ where: { id: 'm-1' } });
      const a = lastAudit();
      expect(a.action).toBe('DELETE');
      expect(a.resourceType).toBe('LlmModel');
    });

    it('should throw MODEL_NOT_FOUND when deleting an unknown model', async () => {
      vi.mocked(prisma.llmModel.findFirst).mockResolvedValue(null as never);
      await expect(
        llmProviderService.deleteModel('p-1', 'nope', actor),
      ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    });
  });
});
