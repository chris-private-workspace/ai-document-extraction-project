# Open Questions（OQ）追蹤

> **本文件追蹤項目中**未解決的設計決策、文檔誤差、規格與代碼不一致**等狀況。AI 助手按 OQ 狀態決定 default behavior（詳見 CLAUDE.md §Open Questions 機制）。
> **最後更新**：2026-07-27（新增 **OQ-Q5** 信心度路由自評不可靠——自 Epic 23 Story 23.3 提升為獨立議題，且同日確認**不隨 Epic 23 的 OQ-E 降級而消失**；OQ-Q2/Q3/Q4 仍 Open）

---

## 機制摘要

| 狀態 | AI 行為 |
|------|---------|
| **Open** | 用 spec/代碼 default 繼續，但 commit message 標註 `Note: depends on OQ-Q<N>` |
| **Resolved** | 直接用 resolved value，無需 note |
| **Blocked** | STOP 對應 work item，ask user |

---

## 當前 Open Questions

### OQ-Q2: Auth 覆蓋率缺口處理優先順序

- **狀態**：🟡 Open
- **問題**：當前 Auth 覆蓋率 60.7%（201/331 routes），距企業級基準 95% 還缺 130 routes
- **資料來源**：Phase 2 安全治理盤點 2026-04-28
- **影響**：開發新 API 時不清楚是否要立刻加 auth（特別是 `/companies/*` `/cost/*` `/reports/*` 等當前無 auth 的 domain）
- **AI Default Behavior**：**新 API 一律加 auth**（除非用戶明確說該 endpoint 為公開）；舊 API 不主動補加（除非屬於當前 task scope）
- **解決方向**：用戶提供完整的「公開 vs 受保護」API 清單
- **相關 CHANGE**：CHANGE-057（API auth coverage 95%），CHANGE-061（permission check unification）

---

### OQ-Q3: RFC 7807 錯誤格式統一進度

- **狀態**：🟡 Open
- **問題**：部分 API 使用 top-level `{ type, title, status, detail }`，部分使用 nested `{ error: {...} }`
- **影響**：前端錯誤處理需 fallback 兼容兩種格式 → 增加複雜度
- **AI Default Behavior**：**新 API 統一採 top-level**；舊 API 在 task scope 內順帶遷移（不主動 refactor）
- **解決方向**：規劃批次遷移 CHANGE（將所有 nested 格式 API 統一）
- **預估工作量**：~40 個 API 文件

---

### OQ-Q4: MappingRule（Epic 4 三層術語映射）在 V3.1 的去留

- **狀態**：🟡 Open
- **問題**：V3.1 GPT Vision 架構下，`MappingRule` 的 `extractionPattern`/`validationPattern` 完全未被使用；Stage 3 原只撈 `fieldName→fieldLabel` 注入 prompt（DB 實查 31 筆中 30 筆為直譯冗餘）。CHANGE-083 已停用該注入，但 `MappingRule` 表、`/rules` 頁面、`/api/rules/*` 自動學習生態（26 檔）仍完整保留。
- **代碼位置**：`src/services/extraction-v3/stages/stage-3-extraction.service.ts`（`loadTier1Mappings`/`loadTier2Mappings` 已標 `@deprecated`）
- **影響**：`/rules` 頁面與 Epic 4 規則自動學習在新架構下實質空轉（產生的規則 V3.1 不採用）；維護成本 vs 保留價值待評估
- **AI Default Behavior**：維持現狀（表與頁面不動）；不主動擴充也不刪除 Epic 4 規則生態
- **解決方向**：用戶決定 —
  - 選項 A：補完 Phase 2，把 forwarder 真實術語差異正規化餵給 GPT（重新啟用 MappingRule 價值）
  - 選項 B：整體退場（移除 `MappingRule` 表 / `/rules` / `/api/rules/*`），另開 CHANGE
- **相關 CHANGE**：CHANGE-083（已停用 Tier1/2 注入）
- **待用戶決策日期**：—

---

### OQ-Q5: 信心度路由主要依據（模型自評）不可靠 — 現行 Azure 流程即存在

- **狀態**：🟡 Open
- **問題**：信心度路由（AUTO_APPROVE ≥90 / QUICK_REVIEW 70–89 / FULL_REVIEW <70）的分數有 **65% 來自模型自評 confidence**（`STAGE_1_COMPANY` 20% + `STAGE_2_FORMAT` 15% + `STAGE_3_EXTRACTION` 30%，見 `src/types/extraction-v3.types.ts:1282-1289`）。實測顯示該自評**與實際正確性脫鉤**，在兩個 provider 上皆然：

  | 量測 | 結果 |
  |---|---|
  | Azure（Phase 0 spike，2026-07-09） | confidence 恆定 **92–99**，42/42 全 AUTO_APPROVE |
  | claude-opus-5（2026-07-27，9 份 × 2 回合） | confidence 恆定 **96–97**，18/18 全 AUTO_APPROVE；同批文件的實際一致率橫跨 **80%–100%** |

  即：準確率相差 20 個百分點的文件，拿到幾乎相同的自評分數。90/70 這兩個切點**實際上沒有在執行它被以為在執行的篩選**。

- **這不是換 provider 才有的問題**：它在**現行 Azure 正式流程**中即已存在，換 provider 只是讓它被量測到。因此**不屬於 Epic 23**，於 2026-07-27 自 Story 23.3 的子項提升為獨立議題。
- **影響**：本該進入人工審核的發票可能被自動放行，且無告警。影響面是每日實際處理量，而非未來的 provider 切換。
- **AI Default Behavior**：**不主動改動信心度演算法**（H1）。維持現行 90/70 與五維權重；相關工作一律先 surface 再動。
- **解決方向**（待用戶決策，非互斥）：
  - 方向 1：降低自評權重，改倚重確定性訊號（金額加總對帳、幣別一致性、日期合法性、參考編號匹配、`FIELD_COMPLETENESS`）
  - 方向 2：引入不依賴自評的外部訊號（雙模型比對——不一致即不自動放行；此類閘門**天生只會更保守**，不需 ground truth 即可安全上線）
  - 方向 3：先量化再決定 —— 需要人工標註的 gold set，或改用審核工作流累積的修正記錄（`corrections` / `field_correction_history` / `review_records`；**本地皆為 0 筆**，Azure DEV 尚未查）
- **相關**：`docs/04-implementation/tech-specs/epic-23-multi-llm-provider/story-23-3-confidence-calibration-design.md` §7.0（OQ-E 已於 2026-07-27 決議降級）
- 🔴 **不因 Epic 23 收線而消失**：2026-07-27 使用者決議「核心提取不換 Azure，非 Azure 僅為可選備援」→ Epic 23 側的 OQ-E 降級、per-model 校準（P2）不執行、gold set 前提（OQ-A）解除。**本 OQ-Q5 不受該決議影響**——它處理的是現行 Azure 流程每天在跑的路由品質，與換不換 provider 無關。換句話說，Epic 23 那條線收掉後，**這是唯一仍然開著的實質議題**。
- **待用戶決策日期**：—

---

## 已解決 Questions（歷史）

> 移到此區段表示已 resolved，AI 直接用 resolved value 即可。

### OQ-Q1: 信心度路由閾值文檔誤差 ✅ Resolved（2026-07-14）

- **原問題**：CLAUDE.md 記錄信心度閾值為 95%/80%，但代碼實際為 90%/70%（`src/services/extraction-v3/confidence-v3-1.service.ts` 第 112-119 行）
- **Resolved value**：**90% / 70%**（AUTO_APPROVE ≥ 90%、QUICK_REVIEW 70–89%、FULL_REVIEW < 70%）
- **決議**：採選項 A —— **修文檔配合代碼，代碼不動**
- **理由**：代碼是實際跑了數個月的行為，歷史資料的路由決策全部基於它；改文檔零風險，改代碼會使歷史資料與新資料的路由結果失去可比性
- **已同步更新**：`CLAUDE.md` §信心度路由機制、§When in Doubt、§當前 Open 差異、`claudedocs/reference/known-discrepancies.md`
- **後續影響**：Epic 23 Story 23.3 的 per-model confidence 校準以 90/70 為基準閾值

---

## Blocked Questions

> 移到此區段表示**等待用戶決策才能繼續**對應 work item。AI 遇到 blocked OQ 必須 STOP 並 ask user。

（暫無記錄）

---

## 處理機制

### 發現新 OQ 時

1. **加入「當前 Open Questions」**並編號（OQ-Q<N>）
2. 明確記錄：問題 / 影響 / AI Default Behavior / 解決方向
3. 在 CLAUDE.md §當前 Open 差異 同步加一條（若屬於差異類）

### OQ 解決時

1. **移到「已解決 Questions」**
2. 標註 resolved date + resolved value
3. 更新對應 CHANGE/FIX 文件
4. 若 AI Default Behavior 改變 → 通知用戶下次 session 起生效

### OQ 升級為 Blocked 時

1. **移到「Blocked Questions」**
2. 明確標註：阻塞了哪些 work item / 需要什麼決策才能解除
3. AI 遇到 blocked OQ 對應 work item 時 → 必須 STOP + ask

---

## 變更歷史

- **2026-07-14**：OQ-Q1（信心度閾值）resolved —— 文檔對齊代碼 90%/70%（CHANGE-104 文檔治理）
- **2026-05-26**：初版（CLAUDE.md v4.0.0 引入 OQ 機制時建立）

---

*本文件由 CLAUDE.md v4.0.0 引入 Open Questions 機制時建立*
