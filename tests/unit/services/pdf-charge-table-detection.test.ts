/**
 * @fileoverview FIX-147 C：PDF 文字層費用表偵測的單元測試
 * @module tests/unit/services/pdf-charge-table-detection
 * @since FIX-147
 * @lastModified 2026-07-31
 *
 * @description
 *   測試資料取自 CEVA_RCIM260069_37388.pdf 的**真實座標**（2026-07-31 以 pdfjs
 *   抽出）。這份文件是本次修復的起因：5 筆費用佔 8 個視覺行，續行與新列的行距
 *   只差 1.6pt，GPT Vision 在渲染圖上分不出來，把 470.06 那筆併進相鄰列而丟失。
 */

import { describe, expect, it } from 'vitest';

import { detectChargeTable } from '@/services/extraction-v3/utils/pdf-converter';

/** 建立一個文字項；width 依字元數估算，使右對齊欄位的右端能對齊 */
function textItem(
  str: string,
  x: number,
  y: number,
  width = str.length * 3.35
): { str: string; transform: number[]; width: number } {
  return { str, transform: [1, 0, 0, 1, x, y], width };
}

/**
 * CEVA_RCIM260069_37388.pdf 第 1 頁費用表的真實版面
 *
 * 金額欄右端一律對齊 471.6，原幣欄右端一律對齊 339.1。
 */
function cevaPageItems() {
  return [
    // 表頭
    textItem('DESCRIPTION', 36.5, 383.9),
    textItem('CUR', 282, 383.9),
    textItem('AMOUNT', 308.3, 383.9),
    textItem('EX RATE', 350.6, 383.9),
    textItem('CHARGES IN HKD', 403.8, 383.9),

    // 第 1 列（有續行）
    textItem('BASIC FREIGHT CHARGE - 1 40GP @ USD 730.00/CN + 1', 36.5, 373),
    textItem('USD', 282.4, 373),
    textItem('1,100.00', 312.3, 373, 26.8),
    textItem('7.892691', 351.9, 373),
    textItem('8,681.96', 444.8, 373, 26.8),
    textItem('20GP @ USD 370.00/CN', 36.5, 364.4), // ← 續行

    // 匯率碎片：baseline 差 0.4pt 被拆到獨立 y，橫向在右側欄
    textItem('7.892691', 354, 354.7),

    // 第 2 列（無續行）
    textItem('DESTINATION HANDLING - 3 TEU @ USD 130.00/TEU', 36.5, 354.3),
    textItem('USD', 282.4, 354.3),
    textItem('390.00', 319, 354.3, 20.1),
    textItem('3,078.15', 444.8, 354.3, 26.8),

    // 第 3 列（有續行）—— 與第 4 列文字同構，是模型併錯的那一組
    textItem('DESTINATION THC - TERMINAL HANDLING CHARGE - 1', 36.5, 341.9),
    textItem('THB', 283.3, 341.9),
    textItem('7,089.00', 312.3, 341.9, 26.8),
    textItem('0.247142', 351.9, 341.9),
    textItem('1,751.99', 444.8, 341.9, 26.8),
    textItem('20GP @ THB 4350.00/CN + 1 40GP @ THB 2739.00/CN', 36.5, 333.3), // ← 續行

    // 第 4 列（有續行）—— 名稱行以 "+" 結尾，這一筆在真實環境中整個消失
    textItem('DESTINATION HANDLING - 1 20GP @ THB 1128.00/CN +', 36.5, 323.1),
    textItem('THB', 283.3, 323.1),
    textItem('1,902.00', 312.3, 323.1, 26.8),
    textItem('0.247142', 351.9, 323.1),
    textItem('470.06', 451.5, 323.1, 20.1),
    textItem('1 40GP @ THB 774.00/CN', 36.5, 314.5), // ← 續行

    textItem('0.247142', 354, 304.8), // 匯率碎片

    // 第 5 列（最後一列，無續行）
    textItem('DELIVERY ORDER FEE', 36.5, 304.4),
    textItem('THB', 283.3, 304.4),
    textItem('2,417.00', 312.3, 304.4, 26.8),
    textItem('597.34', 451.5, 304.4, 20.1),

    // 總計列
    textItem('TOTAL TO PAY BEFORE', 202.7, 221.3),
    textItem('30-May-26', 312.6, 221.3),
    textItem('HKD', 390.7, 221.3),
    textItem('14,579.50', 526.3, 221.3, 30.2),

    // 頁面下方的左對齊文字 —— 絕不可被吸成最後一列的續行
    textItem('FOURTEEN THOUSAND, FIVE HUNDRED AND SEVENTY NINE DOLLARS AND 50 CENTS', 36.5, 201.7),
    textItem('Transfer Funds To:', 36.5, 180.3),
  ];
}

describe('detectChargeTable — CEVA 真實版面', () => {
  it('抽出全部 5 列，而非模型實際回傳的 4 列', () => {
    const result = detectChargeTable(cevaPageItems(), 1);

    expect(result).not.toBeNull();
    expect(result?.rows).toHaveLength(5);
  });

  it('金額取本位幣欄（CHARGES IN HKD），不是原幣 AMOUNT 欄', () => {
    const result = detectChargeTable(cevaPageItems(), 1);

    expect(result?.rows.map((r) => r.amount)).toEqual([
      8681.96, 3078.15, 1751.99, 470.06, 597.34,
    ]);
    // 原幣欄合計為 12,898，與總額對不上，因此不會被選中
    expect(result?.documentTotal).toBe(14579.5);
  });

  it('合計等於文件總額（自證通過的前提）', () => {
    const result = detectChargeTable(cevaPageItems(), 1);
    const sum = (result?.rows ?? []).reduce((acc, r) => acc + r.amount, 0);

    expect(Number(sum.toFixed(2))).toBe(14579.5);
  });

  it('把 470.06 那筆單獨成列 —— 這正是真實環境中消失的那一筆', () => {
    const result = detectChargeTable(cevaPageItems(), 1);
    const row = result?.rows.find((r) => r.amount === 470.06);

    expect(row).toBeDefined();
    expect(row?.description).toContain('1128.00');
    expect(row?.description).toContain('774.00');
  });

  it('續行歸屬正確：THC 那列不可吃到下一列的 1128.00', () => {
    const result = detectChargeTable(cevaPageItems(), 1);
    const thc = result?.rows.find((r) => r.amount === 1751.99);

    expect(thc?.description).toContain('DESTINATION THC');
    expect(thc?.description).toContain('2739.00');
    // 模型實測會把下一列併進來，形成一條 "+" 加法鏈 —— 文字層不可重蹈覆轍
    expect(thc?.description).not.toContain('1128.00');
    expect(thc?.description).not.toContain('774.00');
  });

  it('續行歸屬正確：第 1 列收到自己的續行', () => {
    const result = detectChargeTable(cevaPageItems(), 1);

    expect(result?.rows[0].description).toContain('BASIC FREIGHT CHARGE');
    expect(result?.rows[0].description).toContain('20GP @ USD 370.00/CN');
  });

  it('不把獨立 y 的匯率碎片當成續行', () => {
    const result = detectChargeTable(cevaPageItems(), 1);

    for (const row of result?.rows ?? []) {
      expect(row.description).not.toContain('7.892691');
      expect(row.description).not.toContain('0.247142');
    }
  });

  it('最後一列不吸收頁面下方的左對齊文字', () => {
    const result = detectChargeTable(cevaPageItems(), 1);
    const last = result?.rows[result.rows.length - 1];

    expect(last?.description).toBe('DELIVERY ORDER FEE');
    expect(last?.description).not.toContain('FOURTEEN THOUSAND');
    expect(last?.description).not.toContain('Transfer Funds To');
  });

  it('總計列不被算成費用列', () => {
    const result = detectChargeTable(cevaPageItems(), 1);

    expect(result?.rows.some((r) => r.amount === 14579.5)).toBe(false);
  });
});

describe('detectChargeTable — 自證閘', () => {
  it('沒有文字層（掃描件）回 null', () => {
    expect(detectChargeTable([], 1)).toBeNull();
  });

  it('找不到標示總額的金額時回 null', () => {
    const items = [
      textItem('FREIGHT', 36.5, 300),
      textItem('100.00', 451.5, 300, 20.1),
      textItem('HANDLING', 36.5, 288),
      textItem('50.00', 457, 288, 16.75),
    ];

    expect(detectChargeTable(items, 1)).toBeNull();
  });

  it('合計對不上總額時回 null（寧可不給，不可給錯）', () => {
    const items = [
      textItem('FREIGHT', 36.5, 300),
      textItem('100.00', 451.5, 300, 20.1),
      textItem('HANDLING', 36.5, 288),
      textItem('50.00', 457, 288, 16.75),
      textItem('TOTAL', 36.5, 260),
      // 真實合計為 150.00，這裡標 999.00 → 代表分列有誤，不可注入
      textItem('999.00', 451.5, 260, 20.1),
    ];

    expect(detectChargeTable(items, 1)).toBeNull();
  });

  it('只有一列費用時回 null（不足以構成表格）', () => {
    const items = [
      textItem('FREIGHT', 36.5, 300),
      textItem('100.00', 451.5, 300, 20.1),
      textItem('TOTAL', 36.5, 260),
      textItem('100.00', 451.5, 260, 20.1),
    ];

    expect(detectChargeTable(items, 1)).toBeNull();
  });

  it('容差內的浮點誤差仍視為對得上', () => {
    const items = [
      textItem('FREIGHT', 36.5, 300),
      textItem('100.01', 451.5, 300, 20.1),
      textItem('HANDLING', 36.5, 288),
      textItem('50.00', 457, 288, 16.75),
      textItem('TOTAL', 36.5, 260),
      textItem('150.00', 451.5, 260, 20.1),
    ];

    const result = detectChargeTable(items, 1);
    expect(result?.rows).toHaveLength(2);
  });

  it('括號負數（折讓）正確解析為負值', () => {
    const items = [
      textItem('FREIGHT', 36.5, 300),
      textItem('200.00', 451.5, 300, 20.1),
      textItem('DISCOUNT', 36.5, 288),
      textItem('(50.00)', 448.2, 288, 23.45),
      textItem('TOTAL', 36.5, 260),
      textItem('150.00', 451.5, 260, 20.1),
    ];

    const result = detectChargeTable(items, 1);
    expect(result?.rows.map((r) => r.amount)).toEqual([200, -50]);
  });
});
