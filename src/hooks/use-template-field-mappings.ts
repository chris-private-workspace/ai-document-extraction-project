/**
 * @fileoverview 模版欄位映射 React Query Hooks
 * @description
 *   提供 TemplateFieldMapping 的 CRUD 操作和三層優先級解析的 React Query Hooks
 *
 * @module src/hooks/use-template-field-mappings
 * @since Epic 19 - Story 19.4
 * @lastModified 2026-01-22
 *
 * @features
 *   - 列表查詢（支援篩選和分頁）
 *   - 詳情查詢
 *   - 創建、更新、刪除操作
 *   - 三層優先級解析
 *   - 樂觀更新和快取管理
 *
 * @dependencies
 *   - @tanstack/react-query
 *   - src/types/template-field-mapping.ts
 *   - src/validations/template-field-mapping.ts
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  TemplateFieldMapping,
  TemplateFieldMappingSummary,
  TemplateFieldMappingFilters,
  ResolvedMappingConfig,
  ResolveMappingParams,
} from '@/types/template-field-mapping';
import type {
  CreateTemplateFieldMappingInput,
  UpdateTemplateFieldMappingInput,
} from '@/validations/template-field-mapping';

// ============================================================================
// Query Keys
// ============================================================================

/**
 * Query Keys 工廠
 * 用於管理快取鍵的一致性
 */
export const templateFieldMappingQueryKeys = {
  all: ['template-field-mappings'] as const,
  lists: () => [...templateFieldMappingQueryKeys.all, 'list'] as const,
  list: (filters: TemplateFieldMappingFilters) =>
    [...templateFieldMappingQueryKeys.lists(), filters] as const,
  details: () => [...templateFieldMappingQueryKeys.all, 'detail'] as const,
  detail: (id: string) => [...templateFieldMappingQueryKeys.details(), id] as const,
  resolve: () => [...templateFieldMappingQueryKeys.all, 'resolve'] as const,
  resolveConfig: (params: ResolveMappingParams) =>
    [...templateFieldMappingQueryKeys.resolve(), params] as const,
};

// ============================================================================
// Constants
// ============================================================================

/** 快取過期時間（毫秒） */
const STALE_TIME_MS = 5 * 60 * 1000; // 5 分鐘

// ============================================================================
// Types
// ============================================================================

/**
 * 列表響應類型
 */
interface ListResponse {
  success: boolean;
  data: {
    mappings: TemplateFieldMappingSummary[];
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  };
}

/**
 * 詳情響應類型
 */
interface DetailResponse {
  success: boolean;
  data: TemplateFieldMapping;
}

/**
 * 解析響應類型
 */
interface ResolveResponse {
  success: boolean;
  data: ResolvedMappingConfig;
}

/**
 * 列表 Hook 參數
 */
export interface UseTemplateFieldMappingsParams extends TemplateFieldMappingFilters {
  page?: number;
  limit?: number;
  enabled?: boolean;
}

/**
 * 列表 Hook 返回類型
 */
export interface UseTemplateFieldMappingsResult {
  mappings: TemplateFieldMappingSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * 詳情 Hook 返回類型
 */
export interface UseTemplateFieldMappingResult {
  mapping: TemplateFieldMapping | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * 解析 Hook 返回類型
 */
export interface UseResolveMappingsResult {
  config: ResolvedMappingConfig | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * 取得映射配置列表
 */
async function fetchMappings(
  filters: TemplateFieldMappingFilters,
  page: number,
  limit: number
): Promise<ListResponse> {
  const params = new URLSearchParams();

  if (filters.dataTemplateId) params.set('dataTemplateId', filters.dataTemplateId);
  if (filters.scope) params.set('scope', filters.scope);
  if (filters.companyId) params.set('companyId', filters.companyId);
  if (filters.documentFormatId) params.set('documentFormatId', filters.documentFormatId);
  if (filters.isActive !== undefined) params.set('isActive', String(filters.isActive));
  if (filters.search) params.set('search', filters.search);
  params.set('page', String(page));
  params.set('limit', String(limit));

  const response = await fetch(`/api/v1/template-field-mappings?${params.toString()}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.detail || '取得映射配置列表失敗');
  }

  return response.json();
}

/**
 * 取得映射配置詳情
 */
async function fetchMappingDetail(id: string): Promise<DetailResponse> {
  const response = await fetch(`/api/v1/template-field-mappings/${id}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.detail || '取得映射配置詳情失敗');
  }

  return response.json();
}

/**
 * 創建映射配置
 */
async function createMapping(
  input: CreateTemplateFieldMappingInput
): Promise<DetailResponse> {
  const response = await fetch('/api/v1/template-field-mappings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.detail || '創建映射配置失敗');
  }

  return response.json();
}

/**
 * 更新映射配置
 */
async function updateMapping(
  id: string,
  input: UpdateTemplateFieldMappingInput
): Promise<DetailResponse> {
  const response = await fetch(`/api/v1/template-field-mappings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.detail || '更新映射配置失敗');
  }

  return response.json();
}

/**
 * 刪除映射配置
 */
async function deleteMapping(id: string): Promise<void> {
  const response = await fetch(`/api/v1/template-field-mappings/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.detail || '刪除映射配置失敗');
  }
}

/**
 * 解析映射配置
 */
async function resolveMapping(params: ResolveMappingParams): Promise<ResolveResponse> {
  const urlParams = new URLSearchParams();
  urlParams.set('dataTemplateId', params.dataTemplateId);
  if (params.companyId) urlParams.set('companyId', params.companyId);
  if (params.documentFormatId) urlParams.set('documentFormatId', params.documentFormatId);

  const response = await fetch(
    `/api/v1/template-field-mappings/resolve?${urlParams.toString()}`
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.detail || '解析映射配置失敗');
  }

  return response.json();
}

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * 取得映射配置列表
 *
 * @param params - 查詢參數
 * @returns 映射配置列表和分頁資訊
 *
 * @example
 * ```tsx
 * const { mappings, total, isLoading } = useTemplateFieldMappings({
 *   dataTemplateId: 'xxx',
 *   scope: 'COMPANY',
 *   page: 1,
 *   limit: 20,
 * });
 * ```
 */
export function useTemplateFieldMappings(
  params: UseTemplateFieldMappingsParams = {}
): UseTemplateFieldMappingsResult {
  const { page = 1, limit = 20, enabled = true, ...filters } = params;

  const query = useQuery({
    queryKey: templateFieldMappingQueryKeys.list({ ...filters, page, limit } as TemplateFieldMappingFilters),
    queryFn: () => fetchMappings(filters, page, limit),
    staleTime: STALE_TIME_MS,
    enabled,
  });

  return {
    mappings: query.data?.data.mappings ?? [],
    total: query.data?.data.pagination.total ?? 0,
    page: query.data?.data.pagination.page ?? page,
    limit: query.data?.data.pagination.limit ?? limit,
    totalPages: query.data?.data.pagination.totalPages ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

/**
 * 取得映射配置詳情
 *
 * @param id - 配置 ID
 * @param enabled - 是否啟用查詢
 * @returns 映射配置詳情
 *
 * @example
 * ```tsx
 * const { mapping, isLoading, error } = useTemplateFieldMapping('xxx');
 * ```
 */
export function useTemplateFieldMapping(
  id: string,
  enabled: boolean = true
): UseTemplateFieldMappingResult {
  const query = useQuery({
    queryKey: templateFieldMappingQueryKeys.detail(id),
    queryFn: () => fetchMappingDetail(id),
    staleTime: STALE_TIME_MS,
    enabled: enabled && !!id,
  });

  return {
    mapping: query.data?.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

/**
 * 解析映射配置（三層優先級合併）
 *
 * @param params - 解析參數
 * @param enabled - 是否啟用查詢
 * @returns 合併後的映射配置
 *
 * @example
 * ```tsx
 * const { config, isLoading } = useResolveMappings({
 *   dataTemplateId: 'xxx',
 *   companyId: 'yyy',
 *   documentFormatId: 'zzz',
 * });
 * ```
 */
export function useResolveMappings(
  params: ResolveMappingParams,
  enabled: boolean = true
): UseResolveMappingsResult {
  const query = useQuery({
    queryKey: templateFieldMappingQueryKeys.resolveConfig(params),
    queryFn: () => resolveMapping(params),
    staleTime: STALE_TIME_MS,
    enabled: enabled && !!params.dataTemplateId,
  });

  return {
    config: query.data?.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * 創建映射配置的返回類型
 */
export interface UseCreateTemplateFieldMappingResult {
  createMapping: (input: CreateTemplateFieldMappingInput) => Promise<TemplateFieldMapping>;
  isCreating: boolean;
  error: Error | null;
}

/**
 * 創建映射配置
 *
 * @returns Mutation 函數和狀態
 *
 * @example
 * ```tsx
 * const { createMapping, isCreating } = useCreateTemplateFieldMapping();
 *
 * await createMapping({
 *   dataTemplateId: 'xxx',
 *   scope: 'COMPANY',
 *   companyId: 'yyy',
 *   name: 'DHL 特殊映射',
 *   mappings: [...],
 * });
 * ```
 */
export function useCreateTemplateFieldMapping(): UseCreateTemplateFieldMappingResult {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: createMapping,
    onSuccess: () => {
      // 清除列表快取
      queryClient.invalidateQueries({
        queryKey: templateFieldMappingQueryKeys.lists(),
      });
    },
  });

  return {
    createMapping: async (input: CreateTemplateFieldMappingInput) => {
      const result = await mutation.mutateAsync(input);
      return result.data;
    },
    isCreating: mutation.isPending,
    error: mutation.error as Error | null,
  };
}

/**
 * 更新映射配置的返回類型
 */
export interface UseUpdateTemplateFieldMappingResult {
  updateMapping: (input: UpdateTemplateFieldMappingInput) => Promise<TemplateFieldMapping>;
  isUpdating: boolean;
  error: Error | null;
}

/**
 * 更新映射配置
 *
 * @param id - 配置 ID
 * @returns Mutation 函數和狀態
 *
 * @example
 * ```tsx
 * const { updateMapping, isUpdating } = useUpdateTemplateFieldMapping('xxx');
 *
 * await updateMapping({
 *   name: '新名稱',
 *   mappings: [...],
 * });
 * ```
 */
export function useUpdateTemplateFieldMapping(
  id: string
): UseUpdateTemplateFieldMappingResult {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (input: UpdateTemplateFieldMappingInput) => updateMapping(id, input),
    onSuccess: (data) => {
      // 更新詳情快取
      queryClient.setQueryData(
        templateFieldMappingQueryKeys.detail(id),
        data
      );
      // 清除列表快取
      queryClient.invalidateQueries({
        queryKey: templateFieldMappingQueryKeys.lists(),
      });
      // 清除解析快取
      queryClient.invalidateQueries({
        queryKey: templateFieldMappingQueryKeys.resolve(),
      });
    },
  });

  return {
    updateMapping: async (input: UpdateTemplateFieldMappingInput) => {
      const result = await mutation.mutateAsync(input);
      return result.data;
    },
    isUpdating: mutation.isPending,
    error: mutation.error as Error | null,
  };
}

/**
 * 刪除映射配置的返回類型
 */
export interface UseDeleteTemplateFieldMappingResult {
  deleteMapping: (id: string) => Promise<void>;
  isDeleting: boolean;
  error: Error | null;
}

/**
 * 刪除映射配置
 *
 * @returns Mutation 函數和狀態
 *
 * @remarks
 *   配置 ID 於呼叫 `deleteMapping(id)` 時作為 mutation variable 傳入，
 *   而非以閉包捕獲外部 state，避免外部 state 被重置（如對話框關閉）時
 *   送出空白 id 的競態（FIX-098）。
 *
 * @example
 * ```tsx
 * const { deleteMapping, isDeleting } = useDeleteTemplateFieldMapping();
 *
 * await deleteMapping('xxx');
 * ```
 */
export function useDeleteTemplateFieldMapping(): UseDeleteTemplateFieldMappingResult {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (id: string) => deleteMapping(id),
    onSuccess: (_data, id) => {
      // 清除詳情快取
      queryClient.removeQueries({
        queryKey: templateFieldMappingQueryKeys.detail(id),
      });
      // 清除列表快取
      queryClient.invalidateQueries({
        queryKey: templateFieldMappingQueryKeys.lists(),
      });
      // 清除解析快取
      queryClient.invalidateQueries({
        queryKey: templateFieldMappingQueryKeys.resolve(),
      });
    },
  });

  return {
    deleteMapping: (id: string) => mutation.mutateAsync(id),
    isDeleting: mutation.isPending,
    error: mutation.error as Error | null,
  };
}

// ============================================================================
// Prefetch Functions
// ============================================================================

/**
 * 預取映射配置列表
 */
export function prefetchTemplateFieldMappings(
  queryClient: ReturnType<typeof useQueryClient>,
  params: UseTemplateFieldMappingsParams = {}
): Promise<void> {
  const { page = 1, limit = 20, ...filters } = params;

  return queryClient.prefetchQuery({
    queryKey: templateFieldMappingQueryKeys.list({ ...filters, page, limit } as TemplateFieldMappingFilters),
    queryFn: () => fetchMappings(filters, page, limit),
    staleTime: STALE_TIME_MS,
  });
}

/**
 * 預取映射配置詳情
 */
export function prefetchTemplateFieldMapping(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string
): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: templateFieldMappingQueryKeys.detail(id),
    queryFn: () => fetchMappingDetail(id),
    staleTime: STALE_TIME_MS,
  });
}
