# CHANGE-011: Rules Edit 組件國際化

> **狀態**: ✅ 已完成

## 變更摘要

| 項目 | 內容 |
|------|------|
| 變更編號 | CHANGE-011 |
| 變更日期 | 2026-01-17 |
| 完成日期 | 2026-01-17 |
| 變更類型 | 國際化 (i18n) |
| 影響範圍 | 規則編輯對話框、規則編輯表單 |
| 狀態 | ✅ 已完成 |

---

## 變更原因

1. **i18n 覆蓋遺漏**
   - Epic 17 國際化工作已完成核心頁面
   - Rules Edit 組件（Epic 5 - Story 5.3）仍有硬編碼中文
   - 需要補充國際化以確保完整語言切換支援

2. **硬編碼中文文字統計**
   - `RuleEditDialog.tsx`: 4 處硬編碼中文
   - `RuleEditForm.tsx`: 50+ 處硬編碼中文

---

## 變更內容

### 1. 需要國際化的組件

| 組件 | 路徑 | 優先級 |
|------|------|--------|
| RuleEditDialog | `src/components/features/rules/RuleEditDialog.tsx` | 高 |
| RuleEditForm | `src/components/features/rules/RuleEditForm.tsx` | 高 |

### 2. RuleEditDialog.tsx 硬編碼中文

| 行號 | 原始文字 | 翻譯鍵建議 |
|------|----------|------------|
| 99 | `變更已提交` | `ruleEdit.toast.submitted` |
| 100 | `規則變更請求已提交審核，待審核者批准後生效。` | `ruleEdit.toast.submittedDesc` |
| 117 | `編輯規則：{rule.fieldLabel}` | `ruleEdit.dialog.title` |
| 118-119 | `修改規則配置後提交審核，變更將在審核通過後生效` | `ruleEdit.dialog.description` |

### 3. RuleEditForm.tsx 硬編碼中文

#### 3.1 提取類型選項 (EXTRACTION_TYPES)

| 項目 | label | description |
|------|-------|-------------|
| REGEX | 正則表達式 | 使用正則表達式匹配並提取文字 |
| KEYWORD | 關鍵字 | 根據關鍵字位置提取相鄰文字 |
| POSITION | 座標位置 | 根據 PDF 座標提取特定區域（需 OCR 支援） |
| AI_PROMPT | AI 提示詞 | 使用 AI 理解並提取內容（需 AI 服務） |
| TEMPLATE | 模板匹配 | 使用預定義模板匹配並提取（需模板系統） |

#### 3.2 表單標籤和說明

| 區塊 | 文字內容 |
|------|----------|
| RegexPatternEditor | 正則表達式、旗標 (Flags)、擷取群組索引 |
| KeywordPatternEditor | 關鍵字（每行一個）、搜尋方向、提取長度 |
| AIPromptPatternEditor | AI 提示詞 |
| PreviewResult | 預覽中...、匹配成功、未匹配、信心度:、提取的值 |
| 表單欄位 | 欄位名稱、欄位標籤、提取類型、優先級、信心度閾值、描述、變更原因 |
| 按鈕 | 取消、提交變更、預覽 |

#### 3.3 驗證訊息

| 原始文字 | 翻譯鍵建議 |
|----------|------------|
| `請說明變更原因` | `ruleEdit.validation.reasonRequired` |

#### 3.4 下拉選項

| 區塊 | 選項 |
|------|------|
| Regex Flags | gi (全域, 不分大小寫)、g (全域)、i (不分大小寫)、gim (全域, 不分大小寫, 多行) |
| 搜尋方向 | 右側、左側、下方、上方 |

---

## 翻譯文件結構建議

### messages/zh-TW/rules.json (新增)

```json
{
  "ruleEdit": {
    "dialog": {
      "title": "編輯規則：{fieldLabel}",
      "description": "修改規則配置後提交審核，變更將在審核通過後生效"
    },
    "toast": {
      "submitted": "變更已提交",
      "submittedDesc": "規則變更請求已提交審核，待審核者批准後生效。"
    },
    "form": {
      "fieldName": "欄位名稱",
      "fieldLabel": "欄位標籤",
      "extractionType": "提取類型",
      "patternConfig": "提取模式配置",
      "priority": "優先級 (1-100)",
      "priorityDesc": "數字越大優先級越高",
      "confidence": "信心度閾值 (0-1)",
      "confidenceDesc": "建議 0.7-0.9 之間",
      "description": "描述（選填）",
      "descriptionPlaceholder": "說明此規則的用途或特殊情況...",
      "reason": "變更原因",
      "reasonPlaceholder": "請說明為什麼需要修改此規則...",
      "reasonDesc": "變更原因將記錄在審核歷史中"
    },
    "extractionTypes": {
      "regex": {
        "label": "正則表達式",
        "description": "使用正則表達式匹配並提取文字"
      },
      "keyword": {
        "label": "關鍵字",
        "description": "根據關鍵字位置提取相鄰文字"
      },
      "position": {
        "label": "座標位置",
        "description": "根據 PDF 座標提取特定區域（需 OCR 支援）"
      },
      "aiPrompt": {
        "label": "AI 提示詞",
        "description": "使用 AI 理解並提取內容（需 AI 服務）"
      },
      "template": {
        "label": "模板匹配",
        "description": "使用預定義模板匹配並提取（需模板系統）"
      }
    },
    "regex": {
      "expression": "正則表達式",
      "expressionPlaceholder": "例如: Invoice\\s*(?:No|Number)?[.:]?\\s*(\\S+)",
      "flags": "旗標 (Flags)",
      "flagsGi": "gi (全域, 不分大小寫)",
      "flagsG": "g (全域)",
      "flagsI": "i (不分大小寫)",
      "flagsGim": "gim (全域, 不分大小寫, 多行)",
      "groupIndex": "擷取群組索引"
    },
    "keyword": {
      "keywords": "關鍵字（每行一個）",
      "keywordsPlaceholder": "Invoice No\nInvoice Number\nINV#",
      "direction": "搜尋方向",
      "directionRight": "右側",
      "directionLeft": "左側",
      "directionBelow": "下方",
      "directionAbove": "上方",
      "extractLength": "提取長度"
    },
    "aiPrompt": {
      "prompt": "AI 提示詞",
      "promptPlaceholder": "請從文件中提取發票號碼...",
      "promptDesc": "提示詞將發送給 AI 模型，請清楚描述要提取的內容"
    },
    "position": {
      "notice": "座標位置提取需要 OCR 座標資訊，建議使用測試面板獲取座標"
    },
    "template": {
      "notAvailable": "模板匹配編輯功能尚未開放"
    },
    "preview": {
      "title": "規則預覽",
      "testPlaceholder": "貼上測試文本內容...",
      "button": "預覽",
      "loading": "預覽中...",
      "matched": "匹配成功",
      "notMatched": "未匹配",
      "confidence": "信心度: {value}%",
      "extractedValue": "提取的值",
      "clickToTest": "點擊「預覽」按鈕測試規則效果"
    },
    "buttons": {
      "cancel": "取消",
      "submit": "提交變更"
    },
    "validation": {
      "reasonRequired": "請說明變更原因"
    }
  }
}
```

---

## 修改的檔案

| 檔案路徑 | 變更類型 | 說明 |
|----------|----------|------|
| `messages/zh-TW/rules.json` | 新增 | 繁體中文翻譯 |
| `messages/en/rules.json` | 新增 | 英文翻譯 |
| `src/components/features/rules/RuleEditDialog.tsx` | 修改 | 使用 useTranslations |
| `src/components/features/rules/RuleEditForm.tsx` | 修改 | 使用 useTranslations |

---

## 實作步驟

1. **創建翻譯文件**
   - 新增 `messages/zh-TW/rules.json`
   - 新增 `messages/en/rules.json`

2. **更新 RuleEditDialog.tsx**
   - 添加 `useTranslations` hook
   - 替換 toast 訊息
   - 替換對話框標題和描述

3. **更新 RuleEditForm.tsx**
   - 添加 `useTranslations` hook
   - 將 `EXTRACTION_TYPES` 改為使用 i18n 鍵
   - 替換所有表單標籤、說明、placeholder
   - 替換驗證訊息
   - 替換預覽區域文字
   - 替換按鈕文字

4. **測試驗證**
   - 切換語言確認所有文字正確顯示
   - 確認表單功能正常運作

---

## 測試驗證

| 測試項目 | 預期結果 | 狀態 |
|----------|----------|------|
| 對話框標題 | 根據語言顯示正確文字 | ✅ |
| 提取類型標籤 | 5 種類型都有正確翻譯 | ✅ |
| 表單標籤 | 所有標籤根據語言切換 | ✅ |
| 驗證訊息 | 錯誤訊息根據語言顯示 | ✅ |
| 預覽功能 | 預覽區域文字正確翻譯 | ✅ |
| 按鈕文字 | 取消/提交按鈕正確翻譯 | ✅ |

---

## 相關連結

- **相關 Epic**: Epic 5 - Forwarder 配置管理
- **相關 Story**: Story 5.3 - 編輯 Forwarder 映射規則
- **相關 i18n Epic**: Epic 17 - 國際化支援

---

## 備註

此變更是 Epic 17 國際化工作的延續，目的是確保 Rules Edit 功能在語言切換時能正確顯示對應語言的文字。

**預估工作量**:
- 翻譯文件創建: ~30 分鐘
- 組件更新: ~1 小時
- 測試驗證: ~30 分鐘
