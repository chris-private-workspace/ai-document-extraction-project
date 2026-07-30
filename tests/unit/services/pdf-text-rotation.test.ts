/**
 * @fileoverview CHANGE-113 階段一 A3：頁面內容文字方向偵測單元測試
 * @description
 *   驗證 detectTextRotation 從文字變換矩陣推斷整頁方向的判定。
 *
 *   **這個偵測為何存在**：實測 DHL 發票第 2 頁 `/Rotate` 是 0、頁面尺寸 612×792
 *   直向，但**內容本身**是橫向表格側著排進去的。pdfjs 照 PDF 描述渲染完全正確，
 *   無從得知該轉正，於是送進 GPT 的是一張側躺的圖 —— GPT 讀側躺小字會出錯
 *   （AWB `8365573366` 被讀成 `88557336`），也讀不準每列對應的 shipment。
 *
 *   **為何門檻訂得保守**：轉正改變的是送進 GPT 的圖像本身，轉錯比不轉更糟
 *   （原本側躺至少方向一致，轉錯會變成上下顛倒）。因此方向混雜、文字太少、
 *   斜排等任何不確定的情形一律回 0（維持原樣）。掃描件沒有文字層，items 為空
 *   → 回 0 → 行為與加入本功能之前完全一致。
 *
 * @module tests/unit/services/pdf-text-rotation.test
 * @since CHANGE-113 階段一 A3
 * @lastModified 2026-07-29
 */
import { describe, it, expect } from 'vitest'
import {
  detectTextRotation,
  detectAnnotationRotation,
} from '@/services/extraction-v3/utils/pdf-converter'

/** 建立指定角度（PDF 空間逆時針度數）的文字項目 */
function textAt(degrees: number, str: string, fontSize = 10) {
  const rad = (degrees * Math.PI) / 180
  const a = Math.cos(rad) * fontSize
  const b = Math.sin(rad) * fontSize
  return { transform: [a, b, -b, a, 0, 0], str }
}

/** 10 個字元的填充文字（一個項目即帶 10 點權重） */
const TEN = '0123456789'

describe('CHANGE-113 階段一 A3: 頁面文字方向偵測', () => {
  describe('明確方向', () => {
    it('整頁水平文字 → 0（不轉）', () => {
      const items = [textAt(0, TEN), textAt(0, TEN), textAt(0, TEN)]
      expect(detectTextRotation(items)).toBe(0)
    })

    it('整頁逆時針 90 度（DHL 側躺頁的情形）→ 90', () => {
      const items = [textAt(90, TEN), textAt(90, TEN), textAt(90, TEN)]
      expect(detectTextRotation(items)).toBe(90)
    })

    it('整頁順時針 90 度 → 270', () => {
      const items = [textAt(-90, TEN), textAt(-90, TEN), textAt(-90, TEN)]
      expect(detectTextRotation(items)).toBe(270)
    })

    it('整頁顛倒 → 180', () => {
      const items = [textAt(180, TEN), textAt(180, TEN), textAt(180, TEN)]
      expect(detectTextRotation(items)).toBe(180)
    })
  })

  describe('保守門檻（不確定就不轉）', () => {
    it('沒有文字層（掃描件）→ 0，行為與加入本功能前一致', () => {
      expect(detectTextRotation([])).toBe(0)
    })

    it('方向各半 → 0（主方向佔比未達 60%）', () => {
      const items = [textAt(0, TEN), textAt(0, TEN), textAt(90, TEN), textAt(90, TEN)]
      expect(detectTextRotation(items)).toBe(0)
    })

    it('主方向佔比達 60% 以上 → 採信主方向', () => {
      // 90 度 40 點 vs 水平 20 點 = 66.7%
      const items = [
        textAt(90, TEN),
        textAt(90, TEN),
        textAt(90, TEN),
        textAt(90, TEN),
        textAt(0, TEN),
        textAt(0, TEN),
      ]
      expect(detectTextRotation(items)).toBe(90)
    })

    it('可用字元太少 → 0（不足以代表整頁）', () => {
      // 僅 10 個字元，低於 20 的下限
      expect(detectTextRotation([textAt(90, TEN)])).toBe(0)
    })

    it('斜排文字不列入統計 → 0', () => {
      const items = [textAt(45, TEN), textAt(45, TEN), textAt(45, TEN)]
      expect(detectTextRotation(items)).toBe(0)
    })

    it('輕微傾斜仍歸入最近的方向（容差 10 度內）', () => {
      const items = [textAt(85, TEN), textAt(93, TEN), textAt(88, TEN)]
      expect(detectTextRotation(items)).toBe(90)
    })
  })

  describe('無效項目略過', () => {
    it('缺 transform、矩陣過短、空字串一律不計入', () => {
      const items = [
        { str: TEN }, // 無 transform
        { transform: [1, 0], str: TEN }, // 矩陣過短
        { transform: [10, 0, 0, 10, 0, 0], str: '   ' }, // 空白字串
        { transform: [0, 0, 0, 0, 0, 0], str: TEN }, // 零向量（無方向）
      ]
      expect(detectTextRotation(items)).toBe(0)
    })

    it('無效項目混入時，仍由有效項目決定方向', () => {
      const items = [
        { str: TEN },
        textAt(90, TEN),
        textAt(90, TEN),
        { transform: [0, 0, 0, 0, 0, 0], str: TEN },
        textAt(90, TEN),
      ]
      expect(detectTextRotation(items)).toBe(90)
    })
  })
})

describe('CHANGE-113 階段一 A3: 註解旋轉角備援訊號', () => {
  /**
   * 掃描件沒有文字層 —— detectTextRotation 完全取不到訊號。
   * 實測 DHL_RCIM250111_28699.pdf 兩頁都是純掃描圖（`getTextContent()` 回傳
   * `items: []`），但 FreeText 註解帶著 `rotation: 90`：使用者在側躺頁面上補註時，
   * 會把文字方塊轉到與內容同向才寫得下去，那個角度就是內容的方向。
   */
  it('DHL 實例：兩個註解皆為 90 度 → 90（即實測生效的路徑）', () => {
    expect(detectAnnotationRotation([{ rotation: 90 }, { rotation: 90 }])).toBe(90)
  })

  it('沒有註解 → 0', () => {
    expect(detectAnnotationRotation([])).toBe(0)
  })

  it('註解未帶 rotation（一般水平註解）→ 0', () => {
    expect(detectAnnotationRotation([{}, {}])).toBe(0)
  })

  it('方向不一致（一橫一直）→ 0，無法判斷時不轉', () => {
    expect(detectAnnotationRotation([{ rotation: 0 }, { rotation: 90 }])).toBe(0)
  })

  it('過半支持才採信', () => {
    // 2/3 支持 270 → 採信
    expect(
      detectAnnotationRotation([{ rotation: 270 }, { rotation: 270 }, { rotation: 0 }])
    ).toBe(270)
    // 2/4 支持 90，未過半 → 不轉
    expect(
      detectAnnotationRotation([
        { rotation: 90 },
        { rotation: 90 },
        { rotation: 0 },
        { rotation: 180 },
      ])
    ).toBe(0)
  })

  it('角度正規化：-90 視同 270、360 視同 0', () => {
    expect(detectAnnotationRotation([{ rotation: -90 }, { rotation: -90 }])).toBe(270)
    expect(detectAnnotationRotation([{ rotation: 360 }, { rotation: 360 }])).toBe(0)
  })

  it('非數值角度略過，不致誤判', () => {
    expect(
      detectAnnotationRotation([{ rotation: Number.NaN }, { rotation: Number.NaN }])
    ).toBe(0)
  })
})
