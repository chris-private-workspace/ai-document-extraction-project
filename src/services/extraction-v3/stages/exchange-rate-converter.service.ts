/**
 * @fileoverview Exchange Rate Converter 服務
 * @description
 *   在 extraction pipeline 的 Stage 3 後、TERM_RECORDING 前執行，
 *   將提取的金額轉換為配置的目標貨幣。
 *   功能預設關閉，由 PipelineConfig 控制。
 *
 * @module src/services/extraction-v3/stages/exchange-rate-converter
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-06-01
 *
 * @features
 *   - 轉換 totalAmount, subtotal 等標準欄位
 *   - 可選轉換 lineItems 和 extraCharges
 *   - CHANGE-072: 轉換動態 currency 欄位（stage3Result.fields，依 FieldDefinitionSet 判定）
 *   - CHANGE-072: 換算後覆蓋寫回欄位值，原值保留於 conversions[] 供審計
 *   - 可配置的精度和 fallback 行為
 *   - 非阻塞：失敗依 fallback 策略處理
 *
 * @dependencies
 *   - src/services/exchange-rate.service.ts - convert
 *   - src/services/field-definition-set.service.ts - getMergedResolvedFields (CHANGE-072)
 *   - src/types/extraction-v3.types.ts - ExchangeRateConversionResult
 *
 * @related
 *   - src/services/pipeline-config.service.ts - 配置解析
 *   - src/services/extraction-v3/extraction-v3.service.ts - 主 pipeline
 */

import { convert } from '@/services/exchange-rate.service';
import { getMergedResolvedFields } from '@/services/field-definition-set.service';
import type {
  EffectivePipelineConfig,
  ExchangeRateConversionResult,
  FieldValue,
  FxConversionItem,
  Stage3ExtractionResult,
} from '@/types/extraction-v3.types';

// ============================================================================
// Service Class
// ============================================================================

export class ExchangeRateConverterService {
  /**
   * 執行匯率轉換
   *
   * @param input - 轉換輸入參數
   * @returns 轉換結果
   */
  async convert(input: {
    stage3Result: Stage3ExtractionResult;
    config: EffectivePipelineConfig;
    /** CHANGE-072: 公司 ID（載入合併 FieldDefinitionSet 以判定動態 currency 欄位） */
    companyId?: string;
    /** CHANGE-072: 格式 ID（同上，需與 companyId 並用才查 FORMAT 層） */
    formatId?: string;
  }): Promise<ExchangeRateConversionResult> {
    const startTime = Date.now();
    const { stage3Result, config, companyId, formatId } = input;

    // 功能未啟用
    if (!config.fxConversionEnabled) {
      return {
        enabled: false,
        conversions: [],
        warnings: [],
        processingTimeMs: Date.now() - startTime,
      };
    }

    const targetCurrency = config.fxTargetCurrency;
    if (!targetCurrency) {
      return {
        enabled: true,
        conversions: [],
        warnings: ['FX conversion enabled but no target currency configured'],
        processingTimeMs: Date.now() - startTime,
      };
    }

    // 讀取來源貨幣
    const sourceCurrency = stage3Result.standardFields.currency?.value?.toString();
    if (!sourceCurrency) {
      return {
        enabled: true,
        conversions: [],
        sourceCurrency: undefined,
        targetCurrency,
        warnings: ['No source currency found in extracted data'],
        processingTimeMs: Date.now() - startTime,
      };
    }

    // 相同貨幣不需要轉換
    if (sourceCurrency.toUpperCase() === targetCurrency.toUpperCase()) {
      return {
        enabled: true,
        conversions: [],
        sourceCurrency,
        targetCurrency,
        warnings: [],
        processingTimeMs: Date.now() - startTime,
      };
    }

    const conversions: FxConversionItem[] = [];
    const warnings: string[] = [];
    const precision = config.fxRoundingPrecision;

    // FIX-037 BUG-1: 從 invoiceDate 提取年份
    const invoiceDateValue = stage3Result.standardFields.invoiceDate?.value?.toString();
    let invoiceYear: number | undefined;
    let invoiceDate: Date | undefined;
    if (invoiceDateValue) {
      const parsed = new Date(invoiceDateValue);
      if (!isNaN(parsed.getTime())) {
        invoiceYear = parsed.getFullYear();
        invoiceDate = parsed;
      } else {
        warnings.push(`Invalid invoiceDate "${invoiceDateValue}", falling back to current year`);
      }
    }

    // CHANGE-071: 來源幣別條件 — 文件主幣別是否在過濾清單內（清單空/null = 全轉）
    const sourceCurrencies = config.fxSourceCurrencies ?? null;
    const convertMain = this.shouldConvertCurrency(sourceCurrency, sourceCurrencies);

    // FIX-037 BUG-5: 預查匯率，避免 N+1 查詢
    // 主貨幣對只查一次
    const rateCache = new Map<string, { rate: number; rateId?: string; path: string }>();

    if (convertMain) {
      try {
        const mainResult = await convert(sourceCurrency, targetCurrency, 1, invoiceYear, invoiceDate);
        rateCache.set(
          `${sourceCurrency.toUpperCase()}->${targetCurrency.toUpperCase()}`,
          { rate: mainResult.rate, rateId: mainResult.rateId, path: mainResult.path }
        );
      } catch (error) {
        // 主匯率查詢失敗 — 根據 fallback 策略處理
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        if (config.fxFallbackBehavior === 'error') {
          throw new Error(`FX rate lookup failed for ${sourceCurrency}->${targetCurrency}: ${errorMsg}`);
        }
        warnings.push(`FX rate lookup failed for ${sourceCurrency}->${targetCurrency}: ${errorMsg}`);
        return {
          enabled: true,
          conversions: [],
          sourceCurrency,
          targetCurrency,
          warnings,
          processingTimeMs: Date.now() - startTime,
        };
      }

      // CHANGE-072: 追蹤已換算的 FieldValue 物件（以身分去重），
      // 防止 standardFields 與動態 fields 別名同一物件時被重複換算
      const convertedFieldValues = new Set<FieldValue>();

      // 轉換標準金額欄位
      this.convertStandardFieldsCached(
        stage3Result,
        sourceCurrency,
        targetCurrency,
        precision,
        config.fxFallbackBehavior,
        conversions,
        warnings,
        rateCache,
        convertedFieldValues
      );

      // 轉換 lineItems
      if (config.fxConvertLineItems && stage3Result.lineItems?.length > 0) {
        this.convertLineItemsCached(
          stage3Result,
          sourceCurrency,
          targetCurrency,
          precision,
          conversions,
          rateCache
        );
      }

      // CHANGE-072: 轉換動態 currency 欄位（fields Record）並覆蓋寫回
      if (stage3Result.fields && Object.keys(stage3Result.fields).length > 0) {
        await this.convertDynamicFieldsCached(
          stage3Result,
          sourceCurrency,
          targetCurrency,
          precision,
          conversions,
          rateCache,
          companyId,
          formatId,
          convertedFieldValues
        );
      }

      // CHANGE-072: 主幣別已換算 → 覆蓋文件主幣別欄位為目標幣別
      if (stage3Result.standardFields.currency) {
        stage3Result.standardFields.currency.value = targetCurrency;
      }
    } else if (sourceCurrencies && sourceCurrencies.length > 0) {
      // CHANGE-071: 主幣別不在過濾清單 → 標準欄位/行項目略過（extraCharges 仍依各自幣別判斷）
      warnings.push(
        `來源幣別 ${sourceCurrency} 不在 fxSourceCurrencies 過濾清單內，標準欄位與行項目略過轉換`
      );
    }

    // 轉換 extraCharges（可能有不同貨幣）
    if (config.fxConvertExtraCharges && stage3Result.extraCharges?.length) {
      await this.convertExtraChargesCached(
        stage3Result,
        sourceCurrency,
        targetCurrency,
        precision,
        config.fxFallbackBehavior,
        conversions,
        warnings,
        rateCache,
        invoiceYear,
        invoiceDate,
        sourceCurrencies
      );
    }

    return {
      enabled: true,
      conversions,
      sourceCurrency,
      targetCurrency,
      warnings,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * FIX-037: 使用快取匯率轉換標準欄位（totalAmount, subtotal）
   */
  private convertStandardFieldsCached(
    stage3Result: Stage3ExtractionResult,
    sourceCurrency: string,
    targetCurrency: string,
    precision: number,
    fallbackBehavior: string,
    conversions: FxConversionItem[],
    warnings: string[],
    rateCache: Map<string, { rate: number; rateId?: string; path: string }>,
    convertedFieldValues: Set<FieldValue>
  ): void {
    const amountFields = [
      { field: 'totalAmount', path: 'standardFields.totalAmount' },
      { field: 'subtotal', path: 'standardFields.subtotal' },
    ];

    const cacheKey = `${sourceCurrency.toUpperCase()}->${targetCurrency.toUpperCase()}`;
    const cached = rateCache.get(cacheKey);
    if (!cached) {
      warnings.push(`No cached rate for ${cacheKey}, skipping standard fields`);
      return;
    }

    for (const { field, path } of amountFields) {
      const fieldValue = stage3Result.standardFields[field as keyof typeof stage3Result.standardFields];
      if (!fieldValue?.value) continue;
      // CHANGE-072: 同一 FieldValue 物件只換算一次（避免別名雙重換算）
      if (convertedFieldValues.has(fieldValue)) continue;

      const amount = parseFloat(String(fieldValue.value));
      if (isNaN(amount)) continue;

      const convertedAmount = this.round(amount * cached.rate, precision);
      conversions.push({
        field,
        originalAmount: amount,
        originalCurrency: sourceCurrency,
        convertedAmount,
        targetCurrency,
        rate: cached.rate,
        path,
      });

      // CHANGE-072: 覆蓋寫回換算後金額（原值保留於 conversions[] 供審計）
      fieldValue.value = convertedAmount;
      convertedFieldValues.add(fieldValue);
    }
  }

  /**
   * FIX-037: 使用快取匯率轉換 lineItems
   */
  private convertLineItemsCached(
    stage3Result: Stage3ExtractionResult,
    sourceCurrency: string,
    targetCurrency: string,
    precision: number,
    conversions: FxConversionItem[],
    rateCache: Map<string, { rate: number; rateId?: string; path: string }>
  ): void {
    const cacheKey = `${sourceCurrency.toUpperCase()}->${targetCurrency.toUpperCase()}`;
    const cached = rateCache.get(cacheKey);
    if (!cached) return;

    for (let i = 0; i < stage3Result.lineItems.length; i++) {
      const item = stage3Result.lineItems[i];
      if (item.amount === undefined || item.amount === null) continue;

      const convertedAmount = this.round(item.amount * cached.rate, precision);
      conversions.push({
        field: 'lineItem.amount',
        originalAmount: item.amount,
        originalCurrency: sourceCurrency,
        convertedAmount,
        targetCurrency,
        rate: cached.rate,
        path: `lineItems[${i}].amount`,
      });

      // CHANGE-072: 覆蓋寫回
      item.amount = convertedAmount;
    }
  }

  /**
   * FIX-037: 轉換 extraCharges（支援不同貨幣的快取查詢）
   */
  private async convertExtraChargesCached(
    stage3Result: Stage3ExtractionResult,
    sourceCurrency: string,
    targetCurrency: string,
    precision: number,
    fallbackBehavior: string,
    conversions: FxConversionItem[],
    warnings: string[],
    rateCache: Map<string, { rate: number; rateId?: string; path: string }>,
    invoiceYear?: number,
    invoiceDate?: Date,
    sourceCurrencies?: string[] | null
  ): Promise<void> {
    const charges = stage3Result.extraCharges || [];
    for (let i = 0; i < charges.length; i++) {
      const charge = charges[i];
      if (charge.amount === undefined || charge.amount === null) continue;

      // extraCharge 可能有自己的貨幣
      const chargeCurrency = charge.currency || sourceCurrency;
      if (chargeCurrency.toUpperCase() === targetCurrency.toUpperCase()) continue;
      // CHANGE-071: 附加費依各自幣別套用來源幣別過濾
      if (!this.shouldConvertCurrency(chargeCurrency, sourceCurrencies ?? null)) continue;

      const cacheKey = `${chargeCurrency.toUpperCase()}->${targetCurrency.toUpperCase()}`;
      let cached = rateCache.get(cacheKey);

      // 如果快取中沒有此貨幣對，查詢一次
      if (!cached) {
        try {
          const result = await convert(chargeCurrency, targetCurrency, 1, invoiceYear, invoiceDate);
          cached = { rate: result.rate, rateId: result.rateId, path: result.path };
          rateCache.set(cacheKey, cached);
        } catch (error) {
          this.handleConversionError(error, `extraCharges[${i}].amount`, fallbackBehavior, warnings);
          continue;
        }
      }

      const convertedAmount = this.round(charge.amount * cached.rate, precision);
      conversions.push({
        field: 'extraCharge.amount',
        originalAmount: charge.amount,
        originalCurrency: chargeCurrency,
        convertedAmount,
        targetCurrency,
        rate: cached.rate,
        path: `extraCharges[${i}].amount`,
      });

      // CHANGE-072: 覆蓋寫回 + 幣別改為目標幣別
      charge.amount = convertedAmount;
      charge.currency = targetCurrency;
    }
  }

  /**
   * CHANGE-072: 轉換動態 currency 欄位（stage3Result.fields）並覆蓋寫回
   *
   * @description
   *   CHANGE-042 動態欄位以 Record<string, FieldValue> 儲存，FieldValue 本身不帶 dataType。
   *   透過 companyId + formatId 載入「合併後」的 FieldDefinitionSet（GLOBAL→COMPANY→FORMAT，
   *   與 stage-3 提取時相同語意），篩出 dataType==='currency' 的欄位 key，僅對這些 key 換算。
   *   動態金額視為文件主幣別（sourceCurrency），使用主幣別匯率（rateCache 已預查）。
   *   原值保留於 conversions[] 供審計。
   */
  private async convertDynamicFieldsCached(
    stage3Result: Stage3ExtractionResult,
    sourceCurrency: string,
    targetCurrency: string,
    precision: number,
    conversions: FxConversionItem[],
    rateCache: Map<string, { rate: number; rateId?: string; path: string }>,
    companyId: string | undefined,
    formatId: string | undefined,
    convertedFieldValues: Set<FieldValue>
  ): Promise<void> {
    const fields = stage3Result.fields;
    if (!fields || Object.keys(fields).length === 0) return;

    const cacheKey = `${sourceCurrency.toUpperCase()}->${targetCurrency.toUpperCase()}`;
    const cached = rateCache.get(cacheKey);
    if (!cached) return;

    // 載入合併欄位定義，取得 currency 型別欄位 key 集合
    const mergedDefs = await getMergedResolvedFields(companyId, formatId);
    const currencyKeys = new Set(
      mergedDefs.filter((d) => d.dataType === 'currency').map((d) => d.key)
    );
    if (currencyKeys.size === 0) return;

    for (const key of currencyKeys) {
      const fieldValue = fields[key];
      if (!fieldValue || fieldValue.value === null || fieldValue.value === undefined) continue;
      // CHANGE-072: 同一 FieldValue 物件只換算一次
      // （standardFields.totalAmount 等可能與 fields[snake_case] 別名同一物件）
      if (convertedFieldValues.has(fieldValue)) continue;

      const amount = parseFloat(String(fieldValue.value));
      if (isNaN(amount)) continue;

      const convertedAmount = this.round(amount * cached.rate, precision);
      conversions.push({
        field: key,
        originalAmount: amount,
        originalCurrency: sourceCurrency,
        convertedAmount,
        targetCurrency,
        rate: cached.rate,
        path: `fields.${key}`,
      });

      // 覆蓋寫回換算後金額（原值保留於 conversions[] 供審計）
      fieldValue.value = convertedAmount;
      convertedFieldValues.add(fieldValue);
    }
  }

  /**
   * 處理轉換錯誤
   */
  private handleConversionError(
    error: unknown,
    field: string,
    fallbackBehavior: string,
    warnings: string[]
  ): void {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    if (fallbackBehavior === 'error') {
      throw new Error(`FX conversion failed for ${field}: ${errorMsg}`);
    }

    warnings.push(`FX conversion skipped for ${field}: ${errorMsg}`);
  }

  /**
   * CHANGE-071: 判斷某幣別是否在「只轉指定來源幣別」清單內
   * @returns 清單為空/null → true（全轉，向後相容）；否則僅清單內幣別回 true
   */
  private shouldConvertCurrency(
    currency: string,
    sourceCurrencies: string[] | null
  ): boolean {
    if (!sourceCurrencies || sourceCurrencies.length === 0) return true;
    const upper = currency.toUpperCase();
    return sourceCurrencies.some((c) => c.toUpperCase() === upper);
  }

  /**
   * 四捨五入到指定精度
   */
  private round(value: number, precision: number): number {
    const factor = Math.pow(10, precision);
    return Math.round(value * factor) / factor;
  }
}
