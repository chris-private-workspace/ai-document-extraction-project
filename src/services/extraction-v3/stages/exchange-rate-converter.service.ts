/**
 * @fileoverview Exchange Rate Converter 服務
 * @description
 *   在 extraction pipeline 的 Stage 3 後、TERM_RECORDING 前執行，
 *   將提取的金額轉換為配置的目標貨幣。
 *   功能預設關閉，由 PipelineConfig 控制。
 *
 * @module src/services/extraction-v3/stages/exchange-rate-converter
 * @since CHANGE-032 - Pipeline Reference Number Matching & FX Conversion
 * @lastModified 2026-02-11
 *
 * @features
 *   - 轉換 totalAmount, subtotal 等標準欄位
 *   - 可選轉換 lineItems 和 extraCharges
 *   - 可配置的精度和 fallback 行為
 *   - 原始值不被取代，轉換值作為額外欄位
 *   - 非阻塞：失敗依 fallback 策略處理
 *
 * @dependencies
 *   - src/services/exchange-rate.service.ts - convert
 *   - src/types/extraction-v3.types.ts - ExchangeRateConversionResult
 *
 * @related
 *   - src/services/pipeline-config.service.ts - 配置解析
 *   - src/services/extraction-v3/extraction-v3.service.ts - 主 pipeline
 */

import { convert } from '@/services/exchange-rate.service';
import type {
  EffectivePipelineConfig,
  ExchangeRateConversionResult,
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
  }): Promise<ExchangeRateConversionResult> {
    const startTime = Date.now();
    const { stage3Result, config } = input;

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

      // 轉換標準金額欄位
      this.convertStandardFieldsCached(
        stage3Result,
        sourceCurrency,
        targetCurrency,
        precision,
        config.fxFallbackBehavior,
        conversions,
        warnings,
        rateCache
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
    rateCache: Map<string, { rate: number; rateId?: string; path: string }>
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

      const amount = parseFloat(String(fieldValue.value));
      if (isNaN(amount)) continue;

      conversions.push({
        field,
        originalAmount: amount,
        originalCurrency: sourceCurrency,
        convertedAmount: this.round(amount * cached.rate, precision),
        targetCurrency,
        rate: cached.rate,
        path,
      });
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

      conversions.push({
        field: 'lineItem.amount',
        originalAmount: item.amount,
        originalCurrency: sourceCurrency,
        convertedAmount: this.round(item.amount * cached.rate, precision),
        targetCurrency,
        rate: cached.rate,
        path: `lineItems[${i}].amount`,
      });
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

      conversions.push({
        field: 'extraCharge.amount',
        originalAmount: charge.amount,
        originalCurrency: chargeCurrency,
        convertedAmount: this.round(charge.amount * cached.rate, precision),
        targetCurrency,
        rate: cached.rate,
        path: `extraCharges[${i}].amount`,
      });
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
