/**
 * @fileoverview CHANGE-113 階段一 A：分組鍵候選清單注入單元測試
 * @description
 *   驗證 buildGroupCandidateSection 把 PDF 註解轉成封閉候選清單的行為。
 *
 *   **這段 Prompt 存在的唯一理由是止住編造**。2026-07-29 實測：多 shipment 的
 *   DHL 發票內容側躺，GPT 讀不準每列的 shipment 編號，於是照格式編造
 *   （`HKG-2405-0001`、`HKG-2405-0002` —— 兩個號碼都不存在於任何地方）。
 *   更早一次「三次都讀對」則是因為當時的 prompt 把真實號碼寫進了範例，
 *   GPT 是複製範例而非讀圖；移除範例後隨即改為編造。
 *
 *   把使用者手寫補註的號碼列成封閉清單，GPT 的工作就從「讀出號碼」降級為
 *   「在清單中選一個」—— 值域固定，編造無從發生。
 *
 *   規則 3 / 4 對應模板層 GROUP 展開的**實際行為**：未帶 `groupKey` 的行項目
 *   不歸入任何組，因此「只標一部分」會讓其餘費用整筆從報表消失。此測試把這兩條
 *   釘住，避免將來精簡 Prompt 時把資料遺失的防線一併刪掉。
 *
 * @module tests/unit/services/stage-3-group-candidate-prompt.test
 * @since CHANGE-113 階段一 A
 * @lastModified 2026-07-29
 */
import { describe, it, expect } from 'vitest'
import { buildGroupCandidateSection } from '@/services/extraction-v3/stages/stage-3-extraction.service'
import type { PdfAnnotationInfo } from '@/services/extraction-v3/utils/pdf-converter'

/** 建立註解（painted 與候選清單無關，固定 true 即可） */
function annotation(text: string, pageNumber = 1): PdfAnnotationInfo {
  return { pageNumber, text, painted: true }
}

describe('CHANGE-113 階段一 A: 分組鍵候選清單注入', () => {
  describe('無註解時不注入', () => {
    it('undefined → 空字串', () => {
      expect(buildGroupCandidateSection(undefined)).toBe('')
    })

    it('空陣列 → 空字串', () => {
      expect(buildGroupCandidateSection([])).toBe('')
    })

    it('註解內容全為空白 → 空字串（不注入只有標題的空清單）', () => {
      expect(buildGroupCandidateSection([annotation('  '), annotation('')])).toBe('')
    })
  })

  describe('候選清單內容', () => {
    it('列出各註解原文（DHL 實例的兩個 shipment）', () => {
      const section = buildGroupCandidateSection([
        annotation('RCIM-25-0111'),
        annotation('RCIM-25-0113', 2),
      ])

      expect(section).toContain('- RCIM-25-0111')
      expect(section).toContain('- RCIM-25-0113')
    })

    it('去除前後空白並去重（同一號碼標在多頁只列一次）', () => {
      const section = buildGroupCandidateSection([
        annotation(' RCIM-25-0111 '),
        annotation('RCIM-25-0111', 2),
      ])

      expect(section.match(/- RCIM-25-0111/g)).toHaveLength(1)
    })

    it('不過濾非號碼註解（區域格式各異，任何正則都可能濾掉真號碼）', () => {
      const section = buildGroupCandidateSection([
        annotation('已核准'),
        annotation('RCIM-25-0111'),
      ])

      expect(section).toContain('- 已核准')
      expect(section).toContain('- RCIM-25-0111')
    })

    it('候選數量設上限，避免異常多的註解撐爆 Prompt', () => {
      const many = Array.from({ length: 80 }, (_, i) =>
        annotation(`RCIM-25-${String(i).padStart(4, '0')}`)
      )
      const section = buildGroupCandidateSection(many)

      expect(section.match(/^- RCIM/gm)).toHaveLength(50)
    })
  })

  describe('約束規則（缺一即回到可編造 / 可遺失資料的狀態）', () => {
    const section = buildGroupCandidateSection([
      annotation('RCIM-25-0111'),
      annotation('RCIM-25-0113'),
    ])

    it('要求逐字複製、禁止自行推導 —— 這是止住編造的核心約束', () => {
      expect(section).toContain('MUST be copied verbatim')
      expect(section).toContain('Never invent')
    })

    it('判斷不出時要求留空，而非猜一個', () => {
      expect(section).toContain('leave it unset')
    })

    it('要求全標或全不標 —— 只標一部分會讓其餘費用從報表消失', () => {
      expect(section).toContain('Never tag only some of them')
    })

    it('單一候選時要求全部留空 —— 避免部分標記造成的資料遺失', () => {
      const single = buildGroupCandidateSection([annotation('RCIM-25-0111')])
      expect(single).toContain('exactly one candidate')
    })
  })
})
