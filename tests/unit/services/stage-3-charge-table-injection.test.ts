/**
 * @fileoverview FIX-147 C：費用表 Prompt 段落與功能開關的單元測試
 * @module tests/unit/services/stage-3-charge-table-injection
 * @since FIX-147
 * @lastModified 2026-07-31
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildChargeTableSection } from '@/services/extraction-v3/stages/stage-3-extraction.service';
import type { ChargeTableHint } from '@/services/extraction-v3/utils/pdf-converter';

const FLAG = 'EXTRACTION_CHARGE_TABLE_HINTS';

/** CEVA 那份文件偵測出來的五列 */
const cevaTable: ChargeTableHint = {
  pageNumber: 1,
  documentTotal: 14579.5,
  rows: [
    { description: 'BASIC FREIGHT CHARGE - 1 40GP @ USD 730.00/CN + 1 20GP @ USD 370.00/CN', amount: 8681.96 },
    { description: 'DESTINATION HANDLING - 3 TEU @ USD 130.00/TEU', amount: 3078.15 },
    { description: 'DESTINATION THC - TERMINAL HANDLING CHARGE - 1 20GP @ THB 4350.00/CN + 1 40GP @ THB 2739.00/CN', amount: 1751.99 },
    { description: 'DESTINATION HANDLING - 1 20GP @ THB 1128.00/CN + 1 40GP @ THB 774.00/CN', amount: 470.06 },
    { description: 'DELIVERY ORDER FEE', amount: 597.34 },
  ],
};

describe('buildChargeTableSection', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[FLAG];
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('沒有偵測結果時回空字串（呼叫端因此不注入）', () => {
    expect(buildChargeTableSection(undefined)).toBe('');
    expect(buildChargeTableSection([])).toBe('');
  });

  it('列出每一列的描述與金額', () => {
    const section = buildChargeTableSection([cevaTable]);

    expect(section).toContain('1. BASIC FREIGHT CHARGE');
    expect(section).toContain('— 8681.96');
    expect(section).toContain('4. DESTINATION HANDLING - 1 20GP @ THB 1128.00/CN');
    expect(section).toContain('— 470.06');
    expect(section).toContain('5. DELIVERY ORDER FEE');
  });

  it('標明合計已對過發票總額', () => {
    const section = buildChargeTableSection([cevaTable]);

    expect(section).toContain('Sum: 14579.5');
    expect(section).toContain('verified against the invoice total');
  });

  it('要求逐列輸出、不可合併或漏列', () => {
    const section = buildChargeTableSection([cevaTable]);

    expect(section).toContain('exactly one line item per row');
    expect(section).toContain('never split one row into two or drop one');
    expect(section).toContain('do not merge two rows into one');
  });

  it('保留日期與分類仍需讀圖的指示', () => {
    const section = buildChargeTableSection([cevaTable]);

    expect(section).toContain('must still be read from the image');
  });

  it('講死金額已是結算幣別 —— 不可被描述旁的原幣數字取代', () => {
    // 迴歸守門：措辭曾讓模型在描述含 `THB 7,105.00 @ 0.248019` 的列上填原幣
    const section = buildChargeTableSection([cevaTable]);

    expect(section).toContain('invoice settlement currency');
    expect(section).toContain('Never replace one with a foreign-currency figure');
    // 「currency 從圖片讀」正是造成歧義的措辭，不可回歸
    expect(section).not.toContain('(currency, dates, classification)');
  });

  it('環境變數設為 false 時完全不注入', () => {
    process.env[FLAG] = 'false';

    expect(buildChargeTableSection([cevaTable])).toBe('');
  });

  it('環境變數未設時預設注入', () => {
    expect(buildChargeTableSection([cevaTable])).not.toBe('');
  });

  it('多頁時取列數最多的那一頁，不拼接不同表格', () => {
    const shortTable: ChargeTableHint = {
      pageNumber: 2,
      documentTotal: 100,
      rows: [
        { description: 'ONLY ROW A', amount: 60 },
        { description: 'ONLY ROW B', amount: 40 },
      ],
    };
    const section = buildChargeTableSection([shortTable, cevaTable]);

    expect(section).toContain('page 1');
    expect(section).toContain('DELIVERY ORDER FEE');
    expect(section).not.toContain('ONLY ROW A');
  });

  it('異常長的描述會被截斷，避免撐爆 Prompt', () => {
    const longTable: ChargeTableHint = {
      pageNumber: 1,
      documentTotal: 100,
      rows: [
        { description: 'X'.repeat(1000), amount: 60 },
        { description: 'NORMAL', amount: 40 },
      ],
    };
    const section = buildChargeTableSection([longTable]);

    expect(section).toContain('…');
    // 直接檢查該列被截斷，不用整體長度當代理 —— 規則文字長度會隨措辭調整而變
    const row = section.split('\n').find((l) => l.startsWith('1. '));
    expect(row).toBeDefined();
    expect(row!.length).toBeLessThan(360);
    expect(section).not.toContain('X'.repeat(400));
  });
});
