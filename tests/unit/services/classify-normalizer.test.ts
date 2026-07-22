/**
 * @fileoverview FIX-126 費用標籤對照函數單元測試
 * @description
 *   驗證 classify-normalizer 在 FIX-126 後的三項行為：
 *   - 方案 A：canonicalizeLabel 英文單複數白名單歸一
 *   - 非對稱子字串：僅允許「候選（文件文字）⊇ 目標（定義名稱）」
 *   - 方案 C 基礎：extractChargeDirections 方向詞抽取
 *
 *   測試字串取自使用者 2026-07-14 ~ 07-21 Azure DEV 測試回報的 17 份
 *   真實文件（TOLL / SBS / Nippon Express (HK) / RICOH INTERNATIONAL
 *   LOGISTICS），涵蓋 FIX-126 規劃文件的 5 種失敗模式。
 *
 * @module tests/unit/services/classify-normalizer.test
 * @since FIX-126
 * @lastModified 2026-07-22
 */
import { describe, it, expect } from 'vitest'
import {
  canonicalizeLabel,
  matchLabel,
  extractChargeDirections,
} from '@/services/extraction-v3/utils/classify-normalizer'

describe('FIX-126: canonicalizeLabel 單複數歸一（方案 A）', () => {
  it('白名單內的複數詞應歸一為單數', () => {
    expect(canonicalizeLabel('Terminal Handling Charges')).toBe(
      'terminal handling charge'
    )
    expect(canonicalizeLabel('Documentation Fees')).toBe('documentation fee')
    expect(canonicalizeLabel('Destination Charges & Surcharges')).toBe(
      'destination charge surcharge'
    )
  })

  it('白名單外的詞不得被 stemming（避免製造新誤命中）', () => {
    expect(canonicalizeLabel('Gross Weight')).toBe('gross weight')
    expect(canonicalizeLabel('Customs Class')).toBe('customs class')
    expect(canonicalizeLabel('FCL DGS')).toBe('fcl dgs')
  })

  it('既有正規化行為不變（小寫、去標點、壓縮空白）', () => {
    expect(canonicalizeLabel('VGM ADMIN. CHARGE - FCL')).toBe(
      'vgm admin charge fcl'
    )
    expect(canonicalizeLabel('T.H.C.')).toBe('t h c')
    expect(canonicalizeLabel('')).toBe('')
  })
})

describe('FIX-126: matchLabel 非對稱子字串', () => {
  it('模式 1（單複數）：TOLL 實測 description 應命中單數定義名稱', () => {
    // TOLL_RHIM260048_79294.PDF 實測明細行
    expect(
      matchLabel(
        'Terminal Handling Charges - Origin - 4 40HC Container(s) @ THB 4300.00/Container',
        'Terminal Handling Charge - Origin'
      )
    ).toBe('substring')
    // 純單複數差異 → 歸一後 exact
    expect(
      matchLabel('Terminal Handling Charges - Origin', 'Terminal Handling Charge - Origin')
    ).toBe('exact')
  })

  it('模式 5（結尾誤配）：較短的文件文字不得被較長定義名稱吞掉', () => {
    // 實測誤配：HANDLING CHARGE 正好是 Terminal handling charge 的結尾
    expect(matchLabel('HANDLING CHARGE', 'Terminal handling charge')).toBeNull()
  })

  it('反向包含（定義名稱 ⊇ 候選）一律不命中', () => {
    // 原為「歧義放棄」的來源，FIX-126 明確化為不命中
    expect(
      matchLabel('Terminal Handling Charge', 'Terminal Handling Charge - Origin')
    ).toBeNull()
    expect(matchLabel('DEST CHARGE', 'Delivery Order (Dest Charge)')).toBeNull()
  })

  it('正向包含（文件文字 ⊇ 定義名稱）維持命中', () => {
    expect(matchLabel('NEHK B/L FEE - FCL', 'NEHK B/L FEE')).toBe('substring')
    expect(
      matchLabel(
        'Documentation Fee - Destination - Base Rate HKD 650.00',
        'Documentation Fee - Destination'
      )
    ).toBe('substring')
  })

  it('模式 3（長度門檻）：目標 < 8 字元仍不子字串命中（維持保守，交由 aliases）', () => {
    // canonical 後 'b l fee' 僅 7 字元
    expect(matchLabel('NEHK B/L FEE - FCL', 'B/L fee')).toBeNull()
  })

  it('模式 2（插入詞）：連續子字串斷裂仍不命中（documented limitation，交由 aliases）', () => {
    expect(
      matchLabel(
        '(AIR) DELIVERY ORDER CHARGE DEST CHARGE',
        '(Air) Delivery Order (Dest Charge)'
      )
    ).toBeNull()
  })

  it('exact 對照不受非對稱化影響', () => {
    expect(matchLabel('T.H.C', 'T.H.C')).toBe('exact')
    expect(matchLabel('Seal Charge', 'SEAL CHARGE')).toBe('exact')
  })
})

describe('FIX-126: extractChargeDirections 方向詞抽取（方案 C 基礎）', () => {
  it('應辨識 origin / destination 及其縮寫', () => {
    expect(
      extractChargeDirections('Terminal Handling Charges - Origin - 4 40HC Container(s)')
    ).toEqual(new Set(['origin']))
    expect(extractChargeDirections('(SEA) THC (DEST)')).toEqual(
      new Set(['destination'])
    )
    expect(extractChargeDirections('Documentation Fee - Destination')).toEqual(
      new Set(['destination'])
    )
  })

  it('無方向詞時應回空集合', () => {
    expect(extractChargeDirections('Terminal Handling Charge').size).toBe(0)
    expect(extractChargeDirections('THC').size).toBe(0)
  })

  it('方向詞必須是獨立詞，不得誤認詞中片段', () => {
    // Destuffing 含 dest 前綴但非獨立詞
    expect(extractChargeDirections('Destuffing Charge').size).toBe(0)
    expect(extractChargeDirections('Original Copy Fee').size).toBe(0)
  })
})
