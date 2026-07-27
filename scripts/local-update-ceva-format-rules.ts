/**
 * @fileoverview 修正 CEVA 兩個格式的 identificationRules（v2：文字錨點優先 + 排除檢查）
 * @description
 *   FIX-124 待辦 1 的實際處置。歷經兩輪實機驗證：
 *
 *   【原始狀態】19 份文件被判為新格式。根因是 keywords 把抬頭寫成排他措辭
 *   （第一類「非 (HONG KONG) LTD」／第二類「非 HONG KONG OFFICE」），而 GPT 對同一份 PDF
 *   的抬頭讀法有三種變體；加上條列式 keywords 誘導「逐項全符才算匹配」。
 *
 *   【v1 修正】改為【核心】/【輔助】分層 + 【匹配指引】。結果 isNewFormat 歸零，
 *   但造成 13 份跨類誤判（11 份第二類被判成第一類）。兩個失誤：
 *     (a) 把所有次要特徵降為「不構成排除理由」後拿掉了冗餘，判定全押在單一視覺特徵
 *         （有無 QR code）上，而 GPT 對它的判讀本身不可靠 —— 實測同一份文件時而說有、
 *         時而說無，甚至寫出「F260027…」卻聲稱「並未以字母 F 起首」。
 *     (b) 第一類加了「費用明細亦可能是多欄表格」，侵蝕了第二類的識別特徵。
 *     另外【匹配指引】逼 GPT 二選一，把「可見的失敗（宣告新格式）」換成「隱藏的錯誤（錯誤指派）」。
 *
 *   【v2 修正 —— 本檔】
 *     1. 主要錨點改用**文字欄位**而非視覺特徵：第二類有一整組獨有欄位名
 *        （Original INVOICE / N° / Edited by / TOTAL TO PAY BEFORE / Client Tax ID / Incoterm ref…），
 *        文字辨識比圖形辨識穩定；QR code 降為【輔助】並註明可能誤判。
 *     2. 第一類加【排除】條款：出現任一第二類獨有欄位即改判第二類，恢復冗餘校驗。
 *     3. 第二類加【核心-替代認定】：即使 QR code 與發票號前綴都無法確認，
 *        獨有欄位命中任兩項即可判定，不依賴視覺判讀。
 *     4. 【匹配指引】不再逼二選一 —— 兩類皆不符時仍應回報新格式。
 *     5. 保留 v1 的抬頭放寬（該排他措辭確實是錯的）。
 *
 *   沿用 FIX-121 原則 —— 具體字串一律保留作為弱模型的辨識錨點，可變處就地標註。
 *
 *   🔴 Gated：預設 dry-run，僅印出 before/after；需 RUN_CEVA_FORMAT_RULES_UPDATE=true 才寫入。
 *
 * @module scripts/local-update-ceva-format-rules
 * @since 2026-07-21（FIX-124 待辦 1）
 * @lastModified 2026-07-21
 *
 * @usage
 *   npx tsx scripts/local-update-ceva-format-rules.ts                        # dry-run
 *   RUN_CEVA_FORMAT_RULES_UPDATE=true npx tsx scripts/local-update-ceva-format-rules.ts  # 實際寫入
 */
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config()

interface FormatRulesUpdate {
  /** 格式 id —— 🔴 本地環境專用，Azure 的 id 不同 */
  id: string
  label: string
  rules: {
    keywords: string[]
    priority: number
    layoutHints: string
    logoPatterns: Array<{ position: string; description: string }>
  }
}

/** 第二類獨有欄位 —— 同時用於第一類的【排除】與第二類的【替代認定】，措辭保持一致 */
const TABLE_FORMAT_EXCLUSIVE_FIELDS =
  'Original INVOICE 字樣、N° 欄位、Edited by 欄位、TOTAL TO PAY BEFORE 列、Client Tax ID 欄位、Incoterm ref 欄位、Consol ref 欄位、Operations 或 Tracking ref 欄位'

const UPDATES: FormatRulesUpdate[] = [
  {
    id: 'cmqur1q73000vpkxgx48c54jo',
    label: '第一類：貨運/清關型（深藍實心橫幅、純數字發票號）',
    rules: {
      keywords: [
        // ---- 核心錨點（以文字特徵為主）----
        '【核心】發票號為純數字、無英文字母前綴（如 253250005808，位數可能不同）；表格式 Invoice 的發票號則以字母 F 起首（如 F260017865）',
        '【核心】以深藍色實心橫幅作為區塊標題底色（如 INVOICE、SHIPMENT DETAILS、CHARGES）',
        '【核心】費用明細為等寬字體單欄文字行，匯率以 @ 內嵌於描述句中（如 USD 2,490.00 @ 7.834661，金額與匯率數值每張不同）',

        // ---- 排除條款：恢復冗餘校驗，防止吃掉第二類 ----
        `【排除】若文件出現以下任一項，即不屬本格式，應改判為同公司的「CEVA Logistics 表格式 Invoice（QR code + CUR/EX RATE 分欄費率表）」：${TABLE_FORMAT_EXCLUSIVE_FIELDS}，或費用明細呈現為 DESCRIPTION | CUR | AMOUNT | EX RATE | CHARGES IN ⟨幣別⟩ 的分欄費率表`,

        // ---- 抬頭：三種寫法皆屬本格式 ----
        '【抬頭】頁首公司名可能呈現為 CEVA LOGISTICS HONG KONG OFFICE、CEVA LOGISTICS (HONG KONG) LTD、CEVA LOGISTICS (HONG KONG) OFFICE —— 三種寫法皆屬本格式，不得以抬頭寫法作為排除理由',

        // ---- 輔助特徵 ----
        '【輔助】左上角無 QR code —— 但 QR code 在低解析度下可能漏看或誤判，本項僅供參考，不得單獨作為判定依據',
        '【輔助】右側成組標籤方塊：INVOICE DATE、CUSTOMER ID、SHIPMENT、REGISTRATION #、DUE DATE、TERMS（欄位可能部分缺漏、排列或框線樣式不同，不構成排除理由）',
        '【輔助】含 CONSOL NUMBER 欄位與 PRINTED BY 欄位（影像解析度不足而未能辨識時，不構成排除理由）',
        '【輔助】貨櫃運送時含 CONTAINERS 區塊，單行列出多個櫃號與櫃型；空運或散貨則無此區塊，不構成排除理由',
        '【輔助】頁碼如 Page 1 of 1，位置可能在標題列右端或頁面右上角，位置差異不構成排除理由',
        '【輔助】底部摘要區含 TOTAL CHARGES、SUBTOTAL、BALANCE DUE 等欄位（欄位命名與排版可能不同）',

        // ---- 匹配指引：先排除、再判定，兩者皆不符時仍可回報新格式 ----
        '【匹配指引】判定順序：(1) 先檢查【排除】—— 成立則改判為表格式 Invoice，不得判為本格式；(2) 未觸發排除且符合【核心】特徵時，判定為本格式並回傳其名稱；(3) 兩類皆不符合時，才回報為新格式。【輔助】特徵僅用於提高信心度，其缺漏或呈現方式不同不得作為判定新格式的理由',
      ],
      priority: 60,
      layoutHints:
        '深色橫幅分區、右側鍵值方塊、純數字發票號、費用為等寬單欄文字行（匯率以 @ 內嵌）；若見 Original INVOICE / N° / Edited by / TOTAL TO PAY BEFORE / Client Tax ID 等欄位則屬表格式 Invoice 而非本格式',
      logoPatterns: [
        {
          position: 'top-right',
          description: 'CEVA 紅藍雙色 Logo 位於頁首右上角',
        },
      ],
    },
  },
  {
    id: 'cmrsmg8mb0000bsxgjrqy6ksk',
    label: '第二類：表格式（QR code + CUR/EX RATE 分欄費率表）',
    rules: {
      keywords: [
        // ---- 核心錨點（文字優先）----
        '【核心】發票號以字母 F 起首、後接一串數字（如 F260017865，位數可能不同）；貨運/清關型 Invoice 的發票號則為純數字（如 253250005808）',
        '【核心】費用明細為分欄表格：DESCRIPTION | CUR | AMOUNT | EX RATE | CHARGES IN ⟨帳單幣別⟩（如 CHARGES IN HKD，幣別隨帳單變動）',

        // ---- 替代認定：不依賴 QR code 與發票號的視覺判讀 ----
        `【核心-替代認定】即使上述兩項無法確認，只要出現以下獨有欄位其中任兩項，即應判定為本格式：${TABLE_FORMAT_EXCLUSIVE_FIELDS}`,

        // ---- 抬頭 ----
        '【抬頭】抬頭公司名多為 CEVA LOGISTICS (HONG KONG) LTD，亦可能讀為 CEVA LOGISTICS HONG KONG OFFICE 或 CEVA LOGISTICS (HONG KONG) OFFICE —— 不得以抬頭寫法作為排除理由',

        // ---- 輔助特徵 ----
        '【輔助】左上角有 QR code（方形二維碼）—— 但低解析度下可能未能辨識，未見 QR code 不構成排除理由',
        '【輔助】右上角有框線方塊（框線可能為粗黑線或細線），內含 Original INVOICE、N°、Date、Due On、Terms、Edited by（欄位可能部分缺漏或名稱略異，不構成排除理由）',
        '【輔助】白底細框線表格，無深色實心填充區塊',
        '【輔助】頁碼如 PAGE 1 of 1，位置多在頁面右下角，位置差異不構成排除理由',

        // ---- 匹配指引 ----
        '【匹配指引】判定順序：(1) 符合任一【核心】或【核心-替代認定】條件即判定為本格式並回傳其名稱；(2) 若同時疑似貨運/清關型，以本格式的獨有欄位為準（該些欄位不會出現在貨運/清關型）；(3) 兩類皆不符合時，才回報為新格式。【輔助】特徵僅用於提高信心度，其缺漏不得作為判定新格式的理由',
      ],
      priority: 60,
      layoutHints:
        '發票號以 F 起首、費用為 DESCRIPTION/CUR/AMOUNT/EX RATE/CHARGES IN ⟨幣別⟩ 分欄表格、含 Original INVOICE / N° / Edited by / TOTAL TO PAY BEFORE / Client Tax ID 等獨有欄位；左上角通常有 QR code（可能漏看）',
      logoPatterns: [
        {
          position: 'top-left',
          description: '方形 QR code 位於頁面最左上角，其右側為 CEVA 紅藍雙色 Logo',
        },
      ],
    },
  },
]

async function main() {
  const shouldWrite = process.env.RUN_CEVA_FORMAT_RULES_UPDATE === 'true'
  const { default: prisma } = await import('../src/lib/prisma')

  for (const u of UPDATES) {
    const before = await prisma.documentFormat.findUnique({
      where: { id: u.id },
      select: { id: true, name: true, documentSubtype: true, identificationRules: true },
    })

    if (!before) {
      console.error(
        `\n❌ 找不到格式 ${u.id}（${u.label}）—— 請確認環境（本地與 Azure 的 id 不同）`
      )
      process.exitCode = 1
      continue
    }

    const oldRules = before.identificationRules as
      | { keywords?: string[]; layoutHints?: string }
      | null

    console.log(`\n${'='.repeat(78)}`)
    console.log(`=== ${u.label}`)
    console.log(`    ${before.name}`)
    console.log(`    id=${before.id} subtype=${before.documentSubtype}`)

    console.log(`\n--- 修改前 keywords（${oldRules?.keywords?.length ?? 0} 條）`)
    oldRules?.keywords?.forEach((k, i) => console.log(`  ${i + 1}. ${k}`))

    console.log(`\n--- 修改後 keywords（${u.rules.keywords.length} 條）`)
    u.rules.keywords.forEach((k, i) => console.log(`  ${i + 1}. ${k}`))

    console.log(`\n--- layoutHints`)
    console.log(`  前: ${oldRules?.layoutHints ?? '(無)'}`)
    console.log(`  後: ${u.rules.layoutHints}`)

    if (shouldWrite) {
      await prisma.documentFormat.update({
        where: { id: u.id },
        data: { identificationRules: u.rules },
      })
      console.log(`\n✅ 已寫入 ${u.id}`)
    }
  }

  if (!shouldWrite) {
    console.log(`\n\n🔒 dry-run —— 未寫入任何資料。`)
    console.log(
      `   確認後執行：RUN_CEVA_FORMAT_RULES_UPDATE=true npx tsx scripts/local-update-ceva-format-rules.ts`
    )
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exitCode = 1
})
