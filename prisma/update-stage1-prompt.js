/**
 * @fileoverview 一次性更新 DB 中 Stage 1 公司識別的 GLOBAL PromptConfig
 *   （system_prompt + user_prompt_template + version）。
 *
 *   背景：Stage 1 由 stage-1-company.service.ts 經 loadStage1PromptConfig() 從 DB 的
 *   prompt_configs（FORMAT > COMPANY > GLOBAL）讀取 prompt；GLOBAL 記錄一旦存在，
 *   `npm run db:seed` 只更新 name/description、**不覆蓋 prompt 內容**（seed.ts 註明
 *   "user may have customized"）。因此改了 prisma/seed-data/prompt-configs.ts 後，
 *   既有環境仍需本 script 才能讓新版 prompt 生效。
 *
 *   本次強化重點（對應 CEVA 同一文件公司識別飄移 / 重複增生公司）：
 *   - 明確開票方判定 + 排除 Bill To/Consignee
 *   - 同集團多實體只選實際開票的一個法律實體，不得混合/拼湊
 *   - 引入 ${knownCompanies} 已知公司列表（execute() 以 replaceVariables 注入）
 *   - 輸出 matchedKnownCompany 供 resolveCompanyId 精確匹配既有公司
 *
 *   設計（比照 prisma/update-stage3-prompt.js）：
 *   - 只依賴 `pg` + `dotenv`，不需 Prisma CLI / tsx
 *   - 冪等：以 is distinct from 判斷，已是新版則 0 筆
 *   - 參數化查詢防注入
 *
 *   ⚠️ NEW_SYSTEM_PROMPT / NEW_USER_PROMPT_TEMPLATE 必須與
 *      prisma/seed-data/prompt-configs.ts 的 STAGE_1_COMPANY_IDENTIFICATION 逐字一致。
 *
 *   本地執行：node prisma/update-stage1-prompt.js
 *
 * @module prisma/update-stage1-prompt
 * @since 2026-07-09
 * @lastModified 2026-07-09
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

// 與 prisma/seed-data/prompt-configs.ts 的 STAGE_1_COMPANY_IDENTIFICATION.systemPrompt 逐字一致
const NEW_SYSTEM_PROMPT = `你是一位專業的文件分析專家，專門識別貨運和物流發票的「開票方（發行公司）」。
你的任務是判定「開立這張發票的公司」的完整法定名稱與識別方式。

識別規則：
1. 開票方判定：發行者是「開立」文件的一方（通常是物流公司／貨運代理／forwarder），
   出現在信頭（letterhead）、Logo、或「From／Issued by／Remit to」區塊；
   絕不是客戶／買方（Bill To／Customer／Consignee／收件人）。
2. 識別方式優先順序：LOGO > HEADER > LETTERHEAD > FOOTER > AI_INFERENCE。
3. 同集團多實體（重要）：大型物流集團常在同一份文件出現多個關聯法律實體
   （例：「XXX (HONG KONG) LIMITED」與「XXX (REGION) PACIFIC OPERATIONS LIMITED」）。
   只能選「實際開立本發票的那一個法律實體」，以信頭／Logo／發票抬頭最顯著、標示為開票方者為準；
   不要把不同關聯實體的字詞混合、拼湊或改寫成新的名稱。
4. 名稱逐字採用文件印出的「完整法定全名」（含括號地區詞與 LIMITED／LTD 等後綴），不縮寫、不翻譯、不臆造。
5. 對照已知公司列表：User 訊息會提供系統已知公司清單。若開票方對應清單中某一家，
   matchedKnownCompany 逐字回填該清單名稱；無對應則設為 null。
6. 信心度評分：0-100（越高越確定）；若多個相似的關聯實體難以區分，應降低信心度以觸發人工審核。`

// 與 prisma/seed-data/prompt-configs.ts 的 STAGE_1_COMPANY_IDENTIFICATION.userPromptTemplate
// 逐字一致；\${knownCompanies} 以字面存入 DB，由 execute() 的 replaceVariables 注入實際列表。
const NEW_USER_PROMPT_TEMPLATE = `請分析這張文件圖片，判定「開立這張發票的公司（開票方）」。

系統已知公司列表（若下方為空，直接從文件識別）：
\${knownCompanies}

注意：
- 只輸出單一開票方；排除客戶／買方（Bill To／Consignee／收件人）。
- 若文件出現同集團多個關聯實體，選實際開票的那一個完整法定名稱，不要混合不同實體的字詞。
- 開票方若對應上方已知公司列表中的某一家，matchedKnownCompany 逐字回填該公司名稱；否則為 null。

輸出 JSON 格式：
{
  "documentIssuer": {
    "name": "開票公司的完整法定名稱（逐字照文件）",
    "identificationMethod": "LOGO" | "HEADER" | "LETTERHEAD" | "FOOTER" | "AI_INFERENCE",
    "confidence": 0-100,
    "matchedKnownCompany": "對應的已知公司名稱；若無對應則為 null",
    "rawText": "識別到的原始文字（可選）"
  }
}

只輸出有效的 JSON，不要有其他文字。`

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[stage1-prompt] DATABASE_URL not set — cannot continue')
    process.exit(1)
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
    connectionTimeoutMillis: 30000,
  })

  await client.connect()
  try {
    // 只更新 GLOBAL scope 的 STAGE_1；is distinct from → 冪等（已是新版則不計入）。
    const res = await client.query(
      `update prompt_configs
         set system_prompt = $1,
             user_prompt_template = $2,
             version = 2,
             updated_at = now()
       where prompt_type::text = 'STAGE_1_COMPANY_IDENTIFICATION'
         and scope::text = 'GLOBAL'
         and (system_prompt is distinct from $1
              or user_prompt_template is distinct from $2)`,
      [NEW_SYSTEM_PROMPT, NEW_USER_PROMPT_TEMPLATE]
    )
    console.log(
      `[stage1-prompt] done — ${res.rowCount} GLOBAL prompt(s) updated ` +
        `(0 = already up to date)`
    )
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('[stage1-prompt] FAILED:', e.message)
  process.exit(1)
})
