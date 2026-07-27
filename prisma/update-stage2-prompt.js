/**
 * @fileoverview FIX-115：一次性更新 DB 中 Stage 2 格式識別的 GLOBAL PromptConfig
 *   （system_prompt + user_prompt_template + version）。
 *
 *   背景：Stage 2 由 stage-2-format.service.ts 經 loadStage2PromptConfig() 從 DB 的
 *   prompt_configs（FORMAT > COMPANY > GLOBAL）讀取 prompt。GLOBAL 記錄一旦存在，
 *   `npm run db:seed` 只更新 name/description、**不覆蓋 prompt 內容**（seed.ts 註明
 *   "user may have customized"）。因此改了 prisma/seed-data/prompt-configs.ts 後，
 *   既有環境（本地 / Azure DEV）仍需本 script 才能讓新版 prompt 生效。
 *
 *   本次修正重點（FIX-115）：
 *   - 原 prompt 宣稱「如果提供了已知格式列表，優先嘗試匹配已知格式」，卻**從未引用
 *     `${knownFormats}` 變數** —— 清單因此永遠不會注入。
 *   - 後果：GPT 看不到已知格式 → 憑空生成名稱 → matchedKnownFormat 恆為 null →
 *     resolveFormatId 精確/模糊比對雙雙落空 → 落入 JIT → 撞唯一鍵
 *     (companyId, documentType, documentSubtype) → 沿用該公司唯一格式。
 *     等於 DocumentFormat.identificationRules.keywords 完全不起作用，
 *     每間公司實質上只能有一個格式。
 *   - 修正：引入 `${knownFormats}` / `${companyName}`，並要求 GPT **逐字複製**清單中的
 *     格式名稱 —— 因 resolveFormatId 第一步是拿 matchedKnownFormat 與 DB name 做
 *     **完全相等**比對（stage-2-format.service.ts:478-494），任何改寫即匹配失敗。
 *
 *   設計（比照 prisma/update-stage1-prompt.js）：
 *   - 只依賴 `pg` + `dotenv`，不需 Prisma CLI / tsx
 *   - 冪等：以 is distinct from 判斷，已是新版則回報 0 筆
 *   - 參數化查詢防注入
 *   - 只動 GLOBAL scope；COMPANY / FORMAT scope 的自訂配置不受影響
 *
 *   FIX-121（version 3 → 4）：排他性規則限縮為「結構性特徵」，並說明標註為可變／
 *   條件性的內容不符時不構成排除理由。搭配 identificationRules 就地標註可變性
 *   （如「頁碼位於標題列右端（如 Page 1 of 1，頁次與總頁數可變）」），避免多頁發票、
 *   非 HKD 帳單等情境被誤判為「特徵不存在」而排除正確格式。
 *   ⚠️ 只加一個子句、不新增段落 —— FIX-119 曾以整段但書 + 移除具體範例實作，
 *      導致弱模型（gpt-5.4-nano + low detail）失去辨識錨點、準確度下降而回滾。
 *
 *   ⚠️ NEW_SYSTEM_PROMPT / NEW_USER_PROMPT_TEMPLATE 必須與
 *      prisma/seed-data/prompt-configs.ts 的 STAGE_2_FORMAT_IDENTIFICATION 逐字一致。
 *
 *   本地執行：node prisma/update-stage2-prompt.js
 *   Azure：比照 FIX-105 / FIX-110 經 Kudu ad-hoc 執行（未接入 entrypoint，
 *          避免部署時被動觸發；本操作雖冪等且非破壞性，仍以顯式執行為準）。
 *
 * @module prisma/update-stage2-prompt
 * @since FIX-115 (2026-07-20)
 * @lastModified 2026-07-20 (FIX-121)
 */
const { Client } = require('pg')

// 本地：載入 .env.local（優先）與 .env；dotenv 預設不覆蓋既有值，故先載 .env.local。
try {
  require('dotenv').config({ path: '.env.local' })
  require('dotenv').config()
} catch {
  // dotenv 缺失時，仰賴外部已注入的 process.env.DATABASE_URL
}

function resolveSsl() {
  const url = process.env.DATABASE_URL || ''
  if (/sslmode=require/i.test(url) || /\.postgres\.database\.azure\.com/i.test(url)) {
    return { rejectUnauthorized: false }
  }
  return false
}

// 與 prisma/seed-data/prompt-configs.ts 的 STAGE_2_FORMAT_IDENTIFICATION.systemPrompt 逐字一致
const NEW_SYSTEM_PROMPT = `你是一位專業的文件格式識別專家，專門分析 \${companyName} 的貨運與物流發票版面格式。
你的任務是判斷這張文件屬於下列「已知格式」中的哪一種。

已知格式清單（格式名稱: 該格式的辨識特徵；若下方為空，代表此公司尚無已知格式）：
\${knownFormats}

判斷方式：
1. 逐一比對上列每個格式的辨識特徵，看哪一個與文件圖片最吻合。
2. 特徵具有排他性：若某格式的結構性特徵明確不存在於文件中（例如清單說「左上角有 QR code」但文件沒有），就排除該格式。
   但特徵中標明「可變」「條件性」的部分（頁次、幣別、金額、位數等）不符時，不構成排除理由 —— 括號內的數值僅為範例。
3. 優先依據版面結構與獨有欄位判斷，而非公司名稱或 Logo
   （同一間公司的不同版面都會有相同 Logo，不具鑑別力）。
4. 若清單為空，或所有已知格式都明顯不吻合，則視為新格式。

回傳規則（非常重要）：
- 若判定吻合某個已知格式，matchedKnownFormat 必須**逐字複製**該格式名稱
  （冒號前的完整字串，含括號與標點），不可改寫、不可翻譯、不可截短。
- 同時把 formatName 也填成同一個字串。
- 若為新格式，matchedKnownFormat 填 null，並在 formatName 給一個描述性名稱、
  在 formatCharacteristics 詳細列出版面特徵（信頭位置、表格結構、日期/金額格式、
  文件編號格式、浮水印或標誌性元素）供日後識別。
- 信心度 0-100，反映你對此判斷的確定程度。`

// 與 prisma/seed-data/prompt-configs.ts 的 STAGE_2_FORMAT_IDENTIFICATION.userPromptTemplate 逐字一致
const NEW_USER_PROMPT_TEMPLATE = `請分析這張文件圖片，比對已知格式清單，判斷它屬於哪一個格式。

輸出 JSON 格式：
{
  "formatName": "格式名稱（若匹配已知格式，須與清單中的名稱完全一致）",
  "confidence": 0-100,
  "matchedKnownFormat": "匹配到的已知格式名稱（逐字複製），若無匹配則為 null",
  "formatCharacteristics": [
    "你在文件中實際觀察到、且用來做此判斷的特徵"
  ]
}

只輸出有效的 JSON，不要有其他文字。`

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[stage2-prompt] DATABASE_URL not set — cannot continue')
    process.exit(1)
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })

  await client.connect()
  try {
    // 先報告現況，便於 Kudu log 事後稽核
    const before = await client.query(
      `select id, name, version,
              (system_prompt like '%\${knownFormats}%') as has_var
         from prompt_configs
        where prompt_type::text = 'STAGE_2_FORMAT_IDENTIFICATION'
          and scope::text = 'GLOBAL'`
    )
    before.rows.forEach((r) => {
      console.log(
        `[stage2-prompt] before — id=${r.id} version=${r.version} ` +
          `hasKnownFormatsVar=${r.has_var} name="${r.name}"`
      )
    })

    // 只更新 GLOBAL scope 的 STAGE_2；is distinct from → 冪等（已是新版則不計入）。
    const res = await client.query(
      `update prompt_configs
         set system_prompt = $1,
             user_prompt_template = $2,
             version = 4,
             updated_at = now()
       where prompt_type::text = 'STAGE_2_FORMAT_IDENTIFICATION'
         and scope::text = 'GLOBAL'
         and (system_prompt is distinct from $1
              or user_prompt_template is distinct from $2)`,
      [NEW_SYSTEM_PROMPT, NEW_USER_PROMPT_TEMPLATE]
    )
    console.log(
      `[stage2-prompt] done — ${res.rowCount} GLOBAL prompt(s) updated ` +
        `(0 = already up to date)`
    )

    // 讀回驗證
    const after = await client.query(
      `select id, version,
              (system_prompt like '%\${knownFormats}%') as has_var
         from prompt_configs
        where prompt_type::text = 'STAGE_2_FORMAT_IDENTIFICATION'
          and scope::text = 'GLOBAL'`
    )
    const ok = after.rows.every((r) => r.has_var)
    after.rows.forEach((r) => {
      console.log(
        `[stage2-prompt] after — id=${r.id} version=${r.version} hasKnownFormatsVar=${r.has_var}`
      )
    })
    console.log(`[stage2-prompt] VERIFY_${ok ? 'PASS' : 'FAIL'}`)
    if (!ok) process.exitCode = 1
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[stage2-prompt] FAILED:', e.message)
  process.exit(1)
})
