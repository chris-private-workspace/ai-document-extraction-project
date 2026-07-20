# CHANGE / FIX 狀態索引

> 🤖 **本檔由 `npm run docs:status` 自動生成，請勿手動編輯**（手改會被 CI 的 `docs:check` 擋下）。
> 狀態來源：各 CHANGE/FIX 檔案自身的 `> **狀態**:` 欄位 —— 改狀態請改該檔案，不要改這裡。

## 編號

| 類型 | 份數 | 目前最大編號 | 下一個可用 |
|------|------|-------------|-----------|
| CHANGE | 103 | CHANGE-105 | **CHANGE-106** |
| FIX | 117 | FIX-115 | **FIX-116** |

## 📋 未開始（25）

> 完全未動工的規劃。

| 編號 | 標題 | 狀態 |
|------|------|------|
| [CHANGE-029](4-changes/feature-changes/CHANGE-029-reference-number-ui-consistency.md) | reference number ui consistency | ⏳ 待實作 |
| [CHANGE-044](4-changes/feature-changes/CHANGE-044-line-item-hybrid-dual-mode.md) | line item hybrid dual mode | ⏳ 待實作（依賴 CHANGE-043 完成 + 測試通過） |
| [CHANGE-048](4-changes/feature-changes/CHANGE-048-ref-number-as-row-key.md) | ref number as row key | ⏳ 待實作（待 CHANGE-047 完成後評估） |
| [CHANGE-052](4-changes/feature-changes/CHANGE-052-global-admin-role-name-unification.md) | global admin role name unification | 📋 規劃中 |
| [CHANGE-056](4-changes/feature-changes/CHANGE-056-prisma-migration-baseline.md) | prisma migration baseline | 📋 規劃中（待 CHANGE-055 Phase 1 架構評審完成後實施） |
| [CHANGE-057](4-changes/feature-changes/CHANGE-057-api-auth-coverage-95-percent.md) | api auth coverage 95 percent | 📋 規劃中（規劃日期 2026-04-28） |
| [CHANGE-058](4-changes/feature-changes/CHANGE-058-session-management-hardening.md) | session management hardening | 📋 規劃中（規劃日期 2026-04-28） |
| [CHANGE-059](4-changes/feature-changes/CHANGE-059-privileged-account-step-up-auth.md) | privileged account step up auth | 📋 規劃中（規劃日期 2026-04-28） |
| [CHANGE-060](4-changes/feature-changes/CHANGE-060-http-security-headers-csp.md) | http security headers csp | 📋 規劃中（規劃日期 2026-04-28） |
| [CHANGE-061](4-changes/feature-changes/CHANGE-061-permission-check-unification-withauth-hof.md) | permission check unification withauth hof | 📋 規劃中（規劃日期 2026-04-28） |
| [CHANGE-062](4-changes/feature-changes/CHANGE-062-zod-validation-coverage-95-percent.md) | zod validation coverage 95 percent | 📋 規劃中（規劃日期 2026-04-28） |
| [CHANGE-063](4-changes/feature-changes/CHANGE-063-rate-limit-extension-all-auth-endpoints.md) | rate limit extension all auth endpoints | 📋 規劃中（規劃日期 2026-04-28） |
| [CHANGE-064](4-changes/feature-changes/CHANGE-064-ssrf-protection-whitelist.md) | ssrf protection whitelist | 📋 規劃中 |
| [CHANGE-065](4-changes/feature-changes/CHANGE-065-email-security-alerts-5-rules.md) | email security alerts 5 rules | 📋 規劃中 |
| [CHANGE-066](4-changes/feature-changes/CHANGE-066-audit-log-middleware-adoption.md) | audit log middleware adoption | 📋 規劃中 |
| [CHANGE-067](4-changes/feature-changes/CHANGE-067-governance-baseline-docs.md) | governance baseline docs | 📋 規劃中 |
| [CHANGE-068](4-changes/feature-changes/CHANGE-068-resilience-circuit-breaker-retry-ir-plan.md) | resilience circuit breaker retry ir plan | 📋 規劃中 |
| [CHANGE-069](4-changes/feature-changes/CHANGE-069-aca-acr-bicep-security-hardening.md) | aca acr bicep security hardening | 📋 規劃中 |
| [CHANGE-070](4-changes/feature-changes/CHANGE-070-three-env-isolation-staging.md) | three env isolation staging | 📋 規劃中 |
| [CHANGE-074](4-changes/feature-changes/CHANGE-074-source-field-dynamic-load-company-global-scope-ux.md) | source field dynamic load company global scope ux | ⏳ 待實作 |
| [CHANGE-080](4-changes/feature-changes/CHANGE-080-python-services-auth-rate-limit.md) | python services auth rate limit | ⏳ 待實作（H1 架構，用戶暫未 approve，需先確認部署網路拓撲） |
| [CHANGE-102](4-changes/feature-changes/CHANGE-102-cleanup-legacy-llm-models-stage-config-rename.md) | cleanup legacy llm models stage config rename | ⏳ 待實作 |
| [FIX-055](4-changes/bug-fixes/FIX-055-residual-pii-alert-services.md) | residual pii alert services | 📋 規劃中 |
| [FIX-056](4-changes/bug-fixes/FIX-056-x-dev-bypass-auth-hardening.md) | x dev bypass auth hardening | 📋 規劃中 |
| [FIX-060](4-changes/bug-fixes/FIX-060-template-matching-test-existing-documents-stub.md) | template matching test existing documents stub | 🚧 待修復 |

## 🚧 進行中 / 部分完成（20）

> 含「已實作待驗證」「Phase 1 完成、Phase 2 未做」等未收尾項。

| 編號 | 標題 | 狀態 |
|------|------|------|
| [CHANGE-012](4-changes/feature-changes/CHANGE-012-historical-data-url-navigation.md) | historical data url navigation | 🚧 進行中（⚠️ 需驗證） |
| [CHANGE-016](4-changes/feature-changes/CHANGE-016-e2e-pipeline-phase4-testing.md) | e2e pipeline phase4 testing | ⚠️ 部分完成（測試腳本已建立 commit: `cbb48b6`，驗收項待完成） |
| [CHANGE-055](4-changes/feature-changes/CHANGE-055-azure-deployment-foundation.md) | azure deployment foundation | 🚧 進行中（Phase 2 實施中 — DEV 環境，2026-06-08） |
| [CHANGE-077](4-changes/feature-changes/CHANGE-077-auth-fail-open-dev-bypass-fix.md) | auth fail open dev bypass fix | 🔧 實作中（code + 文件完成、type-check/lint 通過；adapter E2E 待 staging 驗證） |
| [CHANGE-079](4-changes/feature-changes/CHANGE-079-city-scope-idor-unified-fix.md) | city scope idor unified fix | ✅ 已實作（程式碼層面，2026-06-10）：6 套用點全部完成；單元測試 + 執行期待驗證 |
| [CHANGE-091](4-changes/feature-changes/CHANGE-091-template-instance-flow-ux-async-progress.md) | template instance flow ux async progress | 🚧 Phase 1 已完成（2026-06-26）／Phase 2 待實作 |
| [CHANGE-095](4-changes/feature-changes/CHANGE-095-allow-editing-company-code.md) | allow editing company code | 🔬 待 E2E 驗證（實作完成、type-check/lint 通過；使用者自行測試中） |
| [FIX-065](4-changes/bug-fixes/FIX-065-mapping-api-auth-and-city-scope.md) | mapping api auth and city scope | 🔧 認證已修復（2026-06-10）；城市範圍 IDOR 留 WP-4 |
| [FIX-067](4-changes/bug-fixes/FIX-067-v1-confidence-prompts-classified-auth.md) | v1 confidence prompts classified auth | 🔧 部分修復（2026-06-10）：confidence/prompts/classified 已修；`/api/v1` 留 WP-2… |
| [FIX-069](4-changes/bug-fixes/FIX-069-redos-safe-regex-execution.md) | redos safe regex execution | ✅ 核心已完成（2026-06-11，程式碼層面；執行期 staging 驗證待部署） |
| [FIX-071](4-changes/bug-fixes/FIX-071-cost-dos-rate-limit-file-size.md) | cost dos rate limit file size | ✅ 核心已完成（2026-06-11，程式碼層面；BUG-3 dev-only 端點依範圍判斷略過；執行期 staging 驗證待部署） |
| [FIX-082](4-changes/bug-fixes/FIX-082-pdfjs-worker-local-asset.md) | pdfjs worker local asset | ✅ 已實作（待部署後 E2E 驗證） |
| [FIX-085](4-changes/bug-fixes/FIX-085-report-download-private-blob-stream.md) | report download private blob stream | ✅ 已實作（待部署後 Azure 驗證下載） |
| [FIX-094](4-changes/bug-fixes/FIX-094-zombie-processing-stuck-unrecoverable.md) | zombie processing stuck unrecoverable | 🟡 方案 B 已實作（2026-06-28，`type-check` + 改動檔 `lint` 0 error 通過；待部署 Azure… |
| [FIX-102](4-changes/bug-fixes/FIX-102-company-create-edit-formdata-contract-mismatch.md) | company create edit formdata contract mismatch | 🔬 待 E2E 驗證（實作完成、type-check/lint 通過；使用者自行測試中） |
| [FIX-103](4-changes/bug-fixes/FIX-103-companies-i18n-forwarder-leftover-and-new-page.md) | companies i18n forwarder leftover and new page | 🔬 待 E2E 驗證（實作完成、type-check/i18n:check/lint 通過；使用者自行測試中） |
| [FIX-106](4-changes/bug-fixes/FIX-106-ocr-processing-stuck-db-connection-timeout.md) | ocr processing stuck db connection timeout | ✅ 根因已確認（應用端事件迴圈飽和，非 DB 故障）；治本（§5.5）+ 臨時緩解（§5.1）+ 收斂 1（§5.3）已實作並於 2026… |
| [FIX-107](4-changes/bug-fixes/FIX-107-stage2-gpt-transient-failure-batch-ocr-failed.md) | stage2 gpt transient failure batch ocr failed | 🔍 根因已確認（Azure OpenAI 服務端瞬斷，外部因素）；資料已由重試恢復；弱點 A（重試退避）已修並於 2026-07-14 … |
| [FIX-108](4-changes/bug-fixes/FIX-108-stage3-lineitem-backfill-description-matching.md) | stage3 lineitem backfill description matching | ✅ 已實作並已部署 Azure DEV（2026-07-14，映像 `dev-fix108-20260714135401`）；🔴 §6.… |
| [FIX-115](4-changes/bug-fixes/FIX-115-stage2-prompt-missing-knownformats-variable.md) | stage2 prompt missing knownformats variable | 🔬 根因已確認並實證，待批准實作（CEVA 已套用公司級繞法） |

## ❓ 狀態無法解析（0）

> 缺少 `> **狀態**:` 欄位或狀態文字無法歸類 —— 新檔不應出現在此區。

（無）

## ⏸️ 已取代 / 已升級（3）

| 編號 | 標題 | 狀態 |
|------|------|------|
| [CHANGE-105](4-changes/feature-changes/CHANGE-105-office-branch-distinguishing-tokens.md) | office branch distinguishing tokens | ⏸️ 已取代（2026-07-16 同日 revert，前提被證據推翻；見文末「撤銷記錄」） |
| [FIX-010](4-changes/bug-fixes/FIX-010-pdfjs-dist-esm-module-error.md) | pdfjs dist esm module error | ⏸️ 已取代（被 FIX-026 最終方案取代） |
| [FIX-088](4-changes/bug-fixes/FIX-088-systematic-hardcoded-chinese-audit.md) | systematic hardcoded chinese audit | ⬆️ 已升級為 CHANGE-088（2026-06-20）— 階段一盤點完成並經主 session 逐一複驗，確認真洩漏跨 6 模組 7… |

## ✅ 已完成（172）

| 編號 | 標題 | 狀態 |
|------|------|------|
| [CHANGE-001](4-changes/feature-changes/CHANGE-001-native-pdf-dual-processing.md) | native pdf dual processing | ✅ 已完成 |
| [CHANGE-002](4-changes/feature-changes/CHANGE-002-hierarchical-terms-report-export.md) | hierarchical terms report export | ✅ 實作完成 |
| [CHANGE-003](4-changes/feature-changes/CHANGE-003-historical-file-detail-page.md) | historical file detail page | ✅ 已完成 |
| [CHANGE-004](4-changes/feature-changes/CHANGE-004-azure-di-boundingbox-extraction.md) | azure di boundingbox extraction | ✅ 已完成（commit: `5e423f2`） |
| [CHANGE-005](4-changes/feature-changes/CHANGE-005-unified-pipeline-step-reorder.md) | unified pipeline step reorder | ✅ 已完成 |
| [CHANGE-006](4-changes/feature-changes/CHANGE-006-gpt-vision-dynamic-config-extraction.md) | gpt vision dynamic config extraction | ✅ 已完成（commit: `e1930a7`） |
| [CHANGE-007](4-changes/feature-changes/CHANGE-007-forwarders-to-companies-path-refactor.md) | forwarders to companies path refactor | ✅ 已完成 |
| [CHANGE-008](4-changes/feature-changes/CHANGE-008-azurite-dev-storage-integration.md) | azurite dev storage integration | ✅ 已完成 |
| [CHANGE-009](4-changes/feature-changes/CHANGE-009-company-list-ui-and-format-error-handling.md) | company list ui and format error handling | ✅ 已完成 |
| [CHANGE-010](4-changes/feature-changes/CHANGE-010-batch-processing-parallelization.md) | batch processing parallelization | ✅ 已完成 |
| [CHANGE-011](4-changes/feature-changes/CHANGE-011-rules-edit-i18n.md) | rules edit i18n | ✅ 已完成 |
| [CHANGE-013](4-changes/feature-changes/CHANGE-013-e2e-pipeline-phase1-infrastructure.md) | e2e pipeline phase1 infrastructure | ✅ 已完成（commit: `1a9e1d4`） |
| [CHANGE-014](4-changes/feature-changes/CHANGE-014-e2e-pipeline-phase2-core-integration.md) | e2e pipeline phase2 core integration | ✅ 已完成（commit: `32628a2`） |
| [CHANGE-015](4-changes/feature-changes/CHANGE-015-e2e-pipeline-phase3-connect-epic19.md) | e2e pipeline phase3 connect epic19 | ✅ 已完成 |
| [CHANGE-017](4-changes/feature-changes/CHANGE-017-retry-unified-pipeline-integration.md) | retry unified pipeline integration | ✅ 已完成 |
| [CHANGE-018](4-changes/feature-changes/CHANGE-018-invoice-detail-api-enhancement.md) | invoice detail api enhancement | ✅ 已完成（代碼修復部分） |
| [CHANGE-019](4-changes/feature-changes/CHANGE-019-pipeline-intermediate-status-updates.md) | pipeline intermediate status updates | ✅ 已完成 |
| [CHANGE-020](4-changes/feature-changes/CHANGE-020-extraction-v2-prebuilt-document-gpt-mini.md) | extraction v2 prebuilt document gpt mini | ✅ 已完成（commit: `5cadfa3`；後被 CHANGE-021 Extraction V3 取代） |
| [CHANGE-021](4-changes/feature-changes/CHANGE-021-unified-processor-v3-pure-gpt-vision.md) | unified processor v3 pure gpt vision | ✅ 已完成 |
| [CHANGE-022](4-changes/feature-changes/CHANGE-022-v3-ui-update-plan.md) | v3 ui update plan | ✅ 已完成 |
| [CHANGE-023](4-changes/feature-changes/CHANGE-023-ai-details-tab.md) | ai details tab | ✅ 已完成 |
| [CHANGE-024](4-changes/feature-changes/CHANGE-024-three-stage-extraction-architecture.md) | three stage extraction architecture | ✅ Phase 5 完成（整合測試通過） |
| [CHANGE-025](4-changes/feature-changes/CHANGE-025-unified-processing-flow-optimization.md) | unified processing flow optimization | ✅ 已完成 |
| [CHANGE-026](4-changes/feature-changes/CHANGE-026-prompt-config-stage-integration.md) | prompt config stage integration | ✅ 已完成 |
| [CHANGE-027](4-changes/feature-changes/CHANGE-027-prompt-template-insertion.md) | prompt template insertion | ✅ 已完成 |
| [CHANGE-028](4-changes/feature-changes/CHANGE-028-prompt-config-list-collapsible-ui.md) | prompt config list collapsible ui | ✅ 已完成 |
| [CHANGE-030](4-changes/feature-changes/CHANGE-030-sidebar-navigation-reorganization.md) | sidebar navigation reorganization | ✅ 已完成 |
| [CHANGE-031](4-changes/feature-changes/CHANGE-031-frontend-invoice-to-document-rename.md) | frontend invoice to document rename | ✅ 已完成 |
| [CHANGE-032](4-changes/feature-changes/CHANGE-032-pipeline-ref-match-fx-conversion.md) | pipeline ref match fx conversion | ✅ 已完成 |
| [CHANGE-033](4-changes/feature-changes/CHANGE-033-claude-md-token-optimization.md) | claude md token optimization | ✅ 已完成 |
| [CHANGE-034](4-changes/feature-changes/CHANGE-034-app-locale-claude-md.md) | app locale claude md | ✅ 已完成 |
| [CHANGE-035](4-changes/feature-changes/CHANGE-035-reference-number-excel-import.md) | reference number excel import | ✅ 已完成 |
| [CHANGE-036](4-changes/feature-changes/CHANGE-036-ref-match-db-substring.md) | ref match db substring | ✅ 已完成 |
| [CHANGE-037](4-changes/feature-changes/CHANGE-037-data-template-flow-completion.md) | data template flow completion | ✅ 已完成 |
| [CHANGE-038](4-changes/feature-changes/CHANGE-038-template-field-mapping-dynamic-source-fields.md) | template field mapping dynamic source fields | ✅ 已完成 |
| [CHANGE-039](4-changes/feature-changes/CHANGE-039-deployment-seed-data-completion.md) | deployment seed data completion | ✅ 已完成 |
| [CHANGE-040](4-changes/feature-changes/CHANGE-040-block-matching-without-mapping-config.md) | block matching without mapping config | ✅ 已完成 |
| [CHANGE-041](4-changes/feature-changes/CHANGE-041-document-list-bulk-match-integration.md) | document list bulk match integration | ✅ 已完成 |
| [CHANGE-042](4-changes/feature-changes/CHANGE-042-field-definition-dynamic-extraction.md) | field definition dynamic extraction | ✅ Phase 1+2+3 全部完成 |
| [CHANGE-043](4-changes/feature-changes/CHANGE-043-line-item-pivot-flatten.md) | line item pivot flatten | ✅ 已完成 |
| [CHANGE-045](4-changes/feature-changes/CHANGE-045-field-definition-type-and-dynamic-line-items.md) | field definition type and dynamic line items | ✅ 已完成 |
| [CHANGE-046](4-changes/feature-changes/CHANGE-046-classifiedas-normalization-combobox.md) | classifiedas normalization combobox | ✅ 已完成 |
| [CHANGE-047](4-changes/feature-changes/CHANGE-047-inject-ref-number-into-template-row.md) | inject ref number into template row | ✅ 已完成 |
| [CHANGE-049](4-changes/feature-changes/CHANGE-049-user-profile-page.md) | user profile page | ✅ 已完成 |
| [CHANGE-050](4-changes/feature-changes/CHANGE-050-system-settings-hub.md) | system settings hub | ✅ 已完成 |
| [CHANGE-051](4-changes/feature-changes/CHANGE-051-extracted-fields-display-refactor.md) | extracted fields display refactor | ✅ 已完成 |
| [CHANGE-053](4-changes/feature-changes/CHANGE-053-enhance-stage2-hardcoded-prompt.md) | enhance stage2 hardcoded prompt | ✅ 已完成 |
| [CHANGE-054](4-changes/feature-changes/CHANGE-054-deployment-readiness-enhancement.md) | deployment readiness enhancement | ✅ 已完成（2026-04-22） |
| [CHANGE-071](4-changes/feature-changes/CHANGE-071-conditional-fx-conversion-by-company-format.md) | conditional fx conversion by company format | ✅ 已完成（2026-06-01 實作 + config 端到端驗證；文件級 E2E 待測試發票） |
| [CHANGE-072](4-changes/feature-changes/CHANGE-072-fx-conversion-overwrite-writeback-dynamic-fields.md) | fx conversion overwrite writeback dynamic fields | ✅ 已完成（程式碼；type-check / lint 通過。端到端 runtime 驗證待 THB 匯率資料 + 測試發票，見「實作完成… |
| [CHANGE-073](4-changes/feature-changes/CHANGE-073-fx-source-currency-fallback-from-config.md) | fx source currency fallback from config | ✅ 已完成（2026-06-01 實作；H1 已批准、採選項 A fallback-only） |
| [CHANGE-075](4-changes/feature-changes/CHANGE-075-mapping-rule-reorder-buttons-and-dnd.md) | mapping rule reorder buttons and dnd | ✅ 已完成（實作 2026-06-03；建議補手動/E2E 驗證見 §實作記錄） |
| [CHANGE-076](4-changes/feature-changes/CHANGE-076-edit-new-pages-fullwidth-layout-unification.md) | edit new pages fullwidth layout unification | ✅ 已完成（2026-06-05） |
| [CHANGE-078](4-changes/feature-changes/CHANGE-078-middleware-api-auth-gate.md) | middleware api auth gate | ✅ 已完成（程式碼 + 本地 enforce 執行期驗收 2026-06-12 場景 1~5 全通過；production 生效僅需於 A… |
| [CHANGE-081](4-changes/feature-changes/CHANGE-081-disable-dependabot-version-updates.md) | disable dependabot version updates | ✅ 已完成（2026-06-12 用戶 approve + 執行） |
| [CHANGE-082](4-changes/feature-changes/CHANGE-082-admin-user-password-management.md) | admin user password management | ✅ 已完成 |
| [CHANGE-083](4-changes/feature-changes/CHANGE-083-mapping-rule-tier-injection-cleanup.md) | mapping rule tier injection cleanup | ✅ 已完成 |
| [CHANGE-084](4-changes/feature-changes/CHANGE-084-document-list-column-enhancement.md) | document list column enhancement | ✅ 已完成（2026-06-21） |
| [CHANGE-085](4-changes/feature-changes/CHANGE-085-prompt-config-delete-action.md) | prompt config delete action | ✅ 已完成（2026-06-21） |
| [CHANGE-086](4-changes/feature-changes/CHANGE-086-reference-number-document-subtype.md) | reference number document subtype | ✅ 已完成（2026-06-21） |
| [CHANGE-087](4-changes/feature-changes/CHANGE-087-shared-datatable-row-number.md) | shared datatable row number | ✅ Phase 1 + Phase 2/3（主列表）已完成（2026-06-22）。Phase 2 完成全部主列表頁（29 列表組件 + … |
| [CHANGE-088](4-changes/feature-changes/CHANGE-088-hardcoded-chinese-constants-i18n.md) | hardcoded chinese constants i18n | ✅ 已完成（2026-06-22）— 6 Phase + Phase 7 治理擴充全數完成；type-check / eslint / i… |
| [CHANGE-089](4-changes/feature-changes/CHANGE-089-component-jsx-hardcoded-chinese-i18n.md) | component jsx hardcoded chinese i18n | ✅ 已完成（Batch A + 波1(B/C/D) + 波2(E/F) + 補遺(G)，2026-06-22；全站組件級 JSX rend… |
| [CHANGE-090](4-changes/feature-changes/CHANGE-090-user-city-region-access-management-ui.md) | user city region access management ui | ✅ 已完成（2026-06-24） |
| [CHANGE-092](4-changes/feature-changes/CHANGE-092-documents-list-company-column.md) | documents list company column | ✅ 已完成（2026-06-26 實作） |
| [CHANGE-093](4-changes/feature-changes/CHANGE-093-data-templates-instances-list-view-toggle.md) | data templates instances list view toggle | ✅ 已完成（2026-06-26 實作） |
| [CHANGE-094](4-changes/feature-changes/CHANGE-094-line-item-charge-extraction-stability.md) | line item charge extraction stability | ✅ 已完成（方案 B 為主 + A 為輔，2026-06-27 用戶拍板並實作） |
| [CHANGE-098](4-changes/feature-changes/CHANGE-098-db-connection-resilience.md) | db connection resilience | ✅ 已部署 Azure DEV（2026-07-09，映像 `dev-change098-20260709102634`；部署記錄見 `d… |
| [CHANGE-099](4-changes/feature-changes/CHANGE-099-llm-model-selection-management.md) | llm model selection management | ✅ 已完成（2026-07-09；D1 採方案 A = system_configs） |
| [CHANGE-100](4-changes/feature-changes/CHANGE-100-add-gpt54-mini-nano-model-whitelist.md) | add gpt54 mini nano model whitelist | ✅ 已完成（2026-07-09） |
| [CHANGE-101](4-changes/feature-changes/CHANGE-101-batch-template-field-mappings-from-excel.md) | batch template field mappings from excel | ✅ 已完成（2026-07-09 部署 Azure DEV，寫入 18 筆） |
| [CHANGE-103](4-changes/feature-changes/CHANGE-103-stage1-company-matching-anti-duplication.md) | stage1 company matching anti duplication | ✅ 已完成（Phase 1 組件 3 學習迴路 ✅ / Phase 2a `orderBy` ✅ / Phase 2 組件 2+4 tok… |
| [CHANGE-104](4-changes/feature-changes/CHANGE-104-docs-governance-status-index-ci-gate.md) | docs governance status index ci gate | ✅ 已完成（2026-07-14） |
| [FIX-001](4-changes/bug-fixes/FIX-001-code-review-p1-fixes.md) | code review p1 fixes | ✅ 已修復 |
| [FIX-002](4-changes/bug-fixes/FIX-002-company-auto-create-fk-constraint.md) | company auto create fk constraint | ✅ 已完成 |
| [FIX-003](4-changes/bug-fixes/FIX-003-batch-status-logic-contradiction.md) | batch status logic contradiction | ✅ 已修復 |
| [FIX-004](4-changes/bug-fixes/FIX-004-term-aggregation-field-name-error.md) | term aggregation field name error | ✅ 已修復 |
| [FIX-005](4-changes/bug-fixes/FIX-005-gpt-vision-missing-issuer-classification.md) | gpt vision missing issuer classification | ✅ 已完成 |
| [FIX-006](4-changes/bug-fixes/FIX-006-batch-processor-document-format-mapping.md) | batch processor document format mapping | ✅ 已修復並驗證 |
| [FIX-007](4-changes/bug-fixes/FIX-007-term-aggregation-wrong-company-field.md) | term aggregation wrong company field | ✅ 已完成 |
| [FIX-008](4-changes/bug-fixes/FIX-008-pdfjs-dist-ssr-barrel-export.md) | pdfjs dist ssr barrel export | ✅ 已修復並驗證 |
| [FIX-009](4-changes/bug-fixes/FIX-009-zustand-selector-infinite-loop.md) | zustand selector infinite loop | ✅ 已修復並驗證 |
| [FIX-011](4-changes/bug-fixes/FIX-011-pdf-viewer-controlled-mode.md) | pdf viewer controlled mode | ✅ 已完成 |
| [FIX-012](4-changes/bug-fixes/FIX-012-resizable-panel-layout.md) | resizable panel layout | ✅ 已完成 |
| [FIX-013](4-changes/bug-fixes/FIX-013-term-aggregation-address-filtering.md) | term aggregation address filtering | ✅ 已完成 |
| [FIX-014](4-changes/bug-fixes/FIX-014-term-extraction-address-filtering.md) | term extraction address filtering | ✅ 已完成 |
| [FIX-015](4-changes/bug-fixes/FIX-015-export-script-address-filtering.md) | export script address filtering | ✅ 已完成 |
| [FIX-016](4-changes/bug-fixes/FIX-016-issuer-identifier-field-mapping.md) | issuer identifier field mapping | ✅ 已修復 |
| [FIX-017](4-changes/bug-fixes/FIX-017-enhanced-address-term-filtering.md) | enhanced address term filtering | ✅ 已完成 |
| [FIX-018](4-changes/bug-fixes/FIX-018-hierarchical-aggregation-fallback-mode.md) | hierarchical aggregation fallback mode | ✅ 已修復 |
| [FIX-019](4-changes/bug-fixes/FIX-019-pdfjs-dist-nextjs-server-compatibility.md) | pdfjs dist nextjs server compatibility | ✅ 已解決 |
| [FIX-019b](4-changes/bug-fixes/FIX-019b-export-empty-excel-auth-redirect.md) | export empty excel auth redirect | ✅ 已修復 |
| [FIX-020](4-changes/bug-fixes/FIX-020-historical-data-page-bugs.md) | historical data page bugs | ✅ 已修復 |
| [FIX-021](4-changes/bug-fixes/FIX-021-pdf-parse-import-bug.md) | pdf parse import bug | ✅ 已修復 |
| [FIX-022](4-changes/bug-fixes/FIX-022-config-fetching-wrong-prompt-type.md) | config fetching wrong prompt type | ✅ 已修復 |
| [FIX-023](4-changes/bug-fixes/FIX-023-unified-processor-issuer-sync.md) | unified processor issuer sync | ✅ 已修復 |
| [FIX-024](4-changes/bug-fixes/FIX-024-hooks-api-path-errors.md) | hooks api path errors | ✅ 已修復 |
| [FIX-024b](4-changes/bug-fixes/FIX-024b-emailnotverified-error-display.md) | emailnotverified error display | ✅ 已修復 |
| [FIX-025](4-changes/bug-fixes/FIX-025-admin-pages-multiple-issues.md) | admin pages multiple issues | ✅ 已修復 |
| [FIX-026](4-changes/bug-fixes/FIX-026-pdfjs-dist-esm-final-solution.md) | pdfjs dist esm final solution | ✅ 已完成 |
| [FIX-026b](4-changes/bug-fixes/FIX-026b-missing-company-edit-page.md) | missing company edit page | ✅ 已修復 |
| [FIX-027](4-changes/bug-fixes/FIX-027-term-aggregation-empty-report.md) | term aggregation empty report | ✅ 已修復 |
| [FIX-028](4-changes/bug-fixes/FIX-028-company-auto-create-failure.md) | company auto create failure | ✅ 已完成 |
| [FIX-029](4-changes/bug-fixes/FIX-029-i18n-missing-translations-and-namespaces.md) | i18n missing translations and namespaces | ✅ 已完成 |
| [FIX-030](4-changes/bug-fixes/FIX-030-production-auth-session-sync.md) | production auth session sync | ✅ 已完成 |
| [FIX-031](4-changes/bug-fixes/FIX-031-historical-batch-progress-display.md) | historical batch progress display | ✅ 已修復 |
| [FIX-032](4-changes/bug-fixes/FIX-032-field-mapping-config-uuid-validation.md) | field mapping config uuid validation | ✅ 已修復 |
| [FIX-033](4-changes/bug-fixes/FIX-033-template-matching-cuid-validation.md) | template matching cuid validation | ✅ 已完成 |
| [FIX-034](4-changes/bug-fixes/FIX-034-document-detail-page-issues.md) | document detail page issues | ✅ 已完成（commits: `367c8a3`, `36173b0`） |
| [FIX-035](4-changes/bug-fixes/FIX-035-companies-page-build-cache-issues.md) | companies page build cache issues | ✅ 已完成（BUG-2 代碼修復 commit: `65f2199`；BUG-1/3 為快取問題，清除 .next 解決） |
| [FIX-036](4-changes/bug-fixes/FIX-036-ref-number-match-abort-pipeline.md) | ref number match abort pipeline | ✅ 已完成 |
| [FIX-037](4-changes/bug-fixes/FIX-037-exchange-rate-conversion-bugs.md) | exchange rate conversion bugs | ✅ 已完成（2026-02-11） |
| [FIX-038](4-changes/bug-fixes/FIX-038-template-matching-formatid-autocomplete.md) | template matching formatid autocomplete | ✅ 已完成 |
| [FIX-039](4-changes/bug-fixes/FIX-039-extracted-fields-api-historical-file-missing.md) | extracted fields api historical file missing | ✅ 已修復 |
| [FIX-040](4-changes/bug-fixes/FIX-040-use-field-label-intl-error.md) | use field label intl error | ✅ 已修復 |
| [FIX-041](4-changes/bug-fixes/FIX-041-rules-new-i18n-migration-forwarder-terminology.md) | rules new i18n migration forwarder terminology | ✅ 已修復 |
| [FIX-042](4-changes/bug-fixes/FIX-042-rules-edit-api-path-extraction-type-i18n.md) | rules edit api path extraction type i18n | ✅ 已修復 |
| [FIX-043](4-changes/bug-fixes/FIX-043-field-definition-not-injected-stage3-prompt.md) | field definition not injected stage3 prompt | ✅ 已修復 |
| [FIX-044](4-changes/bug-fixes/FIX-044-v3-1-fieldmappings-empty-template-instance.md) | v3 1 fieldmappings empty template instance | ✅ 已完成 |
| [FIX-045](4-changes/bug-fixes/FIX-045-template-matching-field-key-mismatch.md) | template matching field key mismatch | ✅ 已完成 |
| [FIX-046](4-changes/bug-fixes/FIX-046-mapping-rule-transform-type-stale-closure.md) | mapping rule transform type stale closure | ✅ 已完成 |
| [FIX-047](4-changes/bug-fixes/FIX-047-audit-log-role-name-mismatch.md) | audit log role name mismatch | ✅ 已修復 |
| [FIX-048](4-changes/bug-fixes/FIX-048-pipeline-missing-processing-queue-creation.md) | pipeline missing processing queue creation | ✅ 已完成 |
| [FIX-049](4-changes/bug-fixes/FIX-049-prompt-seed-stage2-wrong-content-confidence-range.md) | prompt seed stage2 wrong content confidence range | ✅ 已完成 |
| [FIX-050](4-changes/bug-fixes/FIX-050-auth-config-pii-leakage-console-logs.md) | auth config pii leakage console logs | ✅ 已修復（2026-04-21） |
| [FIX-051](4-changes/bug-fixes/FIX-051-db-context-sql-injection-city-codes.md) | db context sql injection city codes | ✅ 已修復（2026-04-21） |
| [FIX-052](4-changes/bug-fixes/FIX-052-rate-limit-single-instance-redis-migration.md) | rate limit single instance redis migration | ✅ 已修復（2026-04-21） |
| [FIX-053](4-changes/bug-fixes/FIX-053-smart-routing-dual-logic-conflict.md) | smart routing dual logic conflict | ✅ 已修復（2026-04-21） |
| [FIX-054](4-changes/bug-fixes/FIX-054-system-user-id-hardcoded-dev-user.md) | system user id hardcoded dev user | ✅ 已修復（2026-04-22） |
| [FIX-057](4-changes/bug-fixes/FIX-057-stage1-company-matching-jit-duplicates.md) | stage1 company matching jit duplicates | ✅ 已修復（Stage 1 公司配對，2026-05-31 驗證通過）；⚠️ 修復過程發現 Stage 2 同類 sibling bug（… |
| [FIX-058](4-changes/bug-fixes/FIX-058-stage2-format-jit-unique-constraint.md) | stage2 format jit unique constraint | ✅ 已修復（2026-05-31 驗證通過） |
| [FIX-059](4-changes/bug-fixes/FIX-059-monthly-cost-report-nonexistent-ai-cost-column.md) | monthly cost report nonexistent ai cost column | ✅ 已修復 |
| [FIX-061](4-changes/bug-fixes/FIX-061-session-expiry-no-redirect-401-flood.md) | session expiry no redirect 401 flood | ✅ 已修復（含回歸修復 v2；已用 Playwright 端到端實測通過） |
| [FIX-062](4-changes/bug-fixes/FIX-062-review-detail-pdf-cors-and-i18n.md) | review detail pdf cors and i18n | ✅ 已修復 (2026-06-05) |
| [FIX-063](4-changes/bug-fixes/FIX-063-admin-historical-data-term-analysis-auth.md) | admin historical data term analysis auth | ✅ 已修復（2026-06-10） |
| [FIX-064](4-changes/bug-fixes/FIX-064-cost-pricing-auth-and-audit-attribution.md) | cost pricing auth and audit attribution | ✅ 已修復（2026-06-10） |
| [FIX-066](4-changes/bug-fixes/FIX-066-test-endpoints-disable-and-path-traversal.md) | test endpoints disable and path traversal | ✅ 已修復（2026-06-10） |
| [FIX-068](4-changes/bug-fixes/FIX-068-ssrf-host-allowlist-safe-fetch.md) | ssrf host allowlist safe fetch | ✅ 已修復（2026-06-10） |
| [FIX-070](4-changes/bug-fixes/FIX-070-hardcoded-credentials-weak-encryption.md) | hardcoded credentials weak encryption | ✅ 核心已完成（2026-06-11）｜「強制首次改密」依用戶決策移交 [FIX-074](./FIX-074-force-first-l… |
| [FIX-072](4-changes/bug-fixes/FIX-072-audit-attribution-formula-eval-hardening.md) | audit attribution formula eval hardening | ✅ 已完成（2026-06-11） |
| [FIX-073](4-changes/bug-fixes/FIX-073-page-level-authorization-gate.md) | page level authorization gate | ✅ 已完成（2026-06-11） |
| [FIX-074](4-changes/bug-fixes/FIX-074-force-first-login-password-change.md) | force first login password change | ✅ 已完成（2026-06-11，H1/H5 已 approve） |
| [FIX-075](4-changes/bug-fixes/FIX-075-package-lock-cross-platform-sync.md) | package lock cross platform sync | ✅ 已修復（2026-06-12） |
| [FIX-076](4-changes/bug-fixes/FIX-076-codebase-ci-readiness.md) | codebase ci readiness | ✅ 已修復（2026-06-12） |
| [FIX-077](4-changes/bug-fixes/FIX-077-stage1-company-drift-jit-duplicates.md) | stage1 company drift jit duplicates | ✅ 已修復（BUG-1 / BUG-2 程式碼已實作並通過驗證；BUG-3 既有重複公司已合併清理） |
| [FIX-078](4-changes/bug-fixes/FIX-078-upload-blob-container-public-access-not-permitted.md) | upload blob container public access not permitted | ✅ 已修復（2026-06-17，程式碼）｜⏳ 待 Azure 重建映像部署後做執行期驗證 |
| [FIX-079](4-changes/bug-fixes/FIX-079-re2-wasm-runtime-enoent-regression.md) | re2 wasm runtime enoent regression | ✅ 已解決（2026-06-17，映像 `dev-fix080d`，啟動段 re2.wasm ENOENT 歸零） |
| [FIX-080](4-changes/bug-fixes/FIX-080-ocr-pdf-canvas-missing-azure.md) | ocr pdf canvas missing azure | ✅ 已修復並驗證（2026-06-17，映像 `dev-fix080d`，實測上傳→處理成功） |
| [FIX-081](4-changes/bug-fixes/FIX-081-standalone-trace-runtime-deps-audit.md) | standalone trace runtime deps audit | ✅ 已實作（主要三項：pdfkit / openapi / CJK 字型 — Dockerfile + .dockerignore）；🚧… |
| [FIX-083](4-changes/bug-fixes/FIX-083-pdfkit-server-external-and-buffer-pages.md) | pdfkit server external and buffer pages | ✅ 已修復（本地實測：報表成功產生 + 可下載；DB `monthly_reports` status=COMPLETED） |
| [FIX-084](4-changes/bug-fixes/FIX-084-monthly-report-month-timezone-offset.md) | monthly report month timezone offset | ✅ 已修復（程式碼修正；待產一次報表 runtime 驗證） |
| [FIX-086](4-changes/bug-fixes/FIX-086-document-detail-extracted-fields-display.md) | document detail extracted fields display | ✅ 已修復（2026-06-20）— BUG-1/BUG-2/BUG-3 全數完成。BUG-2 版面區隔於 2026-06-20 確認設計… |
| [FIX-087](4-changes/bug-fixes/FIX-087-forwarder-form-hardcoded-chinese-labels.md) | forwarder form hardcoded chinese labels | ✅ 已修復（2026-06-20）— 實際僅改 `ForwarderForm.tsx`（12 處 `FORWARDER_FORM_LABE… |
| [FIX-089](4-changes/bug-fixes/FIX-089-upload-limit-hint-visibility.md) | upload limit hint visibility | ✅ 已修復（2026-06-20）— `upload/page.tsx` `CardDescription` 新增上限說明（`UPLOAD… |
| [FIX-090](4-changes/bug-fixes/FIX-090-admin-created-local-account-email-not-verified.md) | admin created local account email not verified | ✅ 已完成（2026-06-22） |
| [FIX-091](4-changes/bug-fixes/FIX-091-recent-documents-table-invoice-namespace-missing.md) | recent documents table invoice namespace missing | ✅ 已修復（2026-06-22）— 在 `companies.json` `recentDocs` 下補 `status` 子物件（5 … |
| [FIX-092](4-changes/bug-fixes/FIX-092-refmatch-not-persisted-unified-path.md) | refmatch not persisted unified path | ✅ 已修復（2026-06-26）— `convertV3Result` + `persistProcessingResult`（crea… |
| [FIX-093](4-changes/bug-fixes/FIX-093-stage3-invoicedata-wrapper-format-parse-loss.md) | stage3 invoicedata wrapper format parse loss | ✅ 已修復（2026-06-27）— `parseExtractionResult` 新增 `invoiceData` 包裹格式攤平（`u… |
| [FIX-095](4-changes/bug-fixes/FIX-095-stage3-prompt-format-conflict-confidence-nondeterminism.md) | stage3 prompt format conflict confidence nondeterminism | ✅ 已修復（本地 + Azure 全鏈完成）— A1+A2+B 程式碼 + A3 DB prompt 更新皆完成；本地與 Azure UI… |
| [FIX-096](4-changes/bug-fixes/FIX-096-document-detail-delete-405-no-handler.md) | document detail delete 405 no handler | ✅ 已修復（2026-06-29，採方案 B 授權；本地 type-check / lint / live E2E 通過） |
| [FIX-097](4-changes/bug-fixes/FIX-097-documents-authz-wrong-session-fields.md) | documents authz wrong session fields | ✅ 已修復（2026-06-29，3 路由全修；type-check / lint / live 驗證通過） |
| [FIX-098](4-changes/bug-fixes/FIX-098-template-field-mapping-delete-empty-id-race.md) | template field mapping delete empty id race | ✅ 已修復（2026-06-29，本地 type-check / lint / Playwright live E2E 通過） |
| [FIX-099](4-changes/bug-fixes/FIX-099-template-field-mapping-list-total-count-zero.md) | template field mapping list total count zero | ✅ 已修復（2026-06-29，本地 type-check / lint / Playwright live E2E 通過） |
| [FIX-100](4-changes/bug-fixes/FIX-100-upload-blocks-documents-page-event-loop.md) | upload blocks documents page event loop | ✅ 已實作（2026-06-29，type-check / lint 通過；端到端效果建議實測驗證） |
| [FIX-104](4-changes/bug-fixes/FIX-104-stage1-issuer-prompt-multi-entity-known-company-anchoring.md) | stage1 issuer prompt multi entity known company anchoring | ✅ 已修復（2026-07-09）— Stage 1 prompt 四處副本強化 + 本地 DB 既有 2 筆 GLOBAL 記錄更新；`… |
| [FIX-105](4-changes/bug-fixes/FIX-105-ceva-duplicate-company-cleanup-rename.md) | ceva duplicate company cleanup rename | ✅ 本地已修復 / ✅ Azure DEV 已同步（2026-07-16：合併 5 筆 source + 正名 + 112 筆轉移，rea… |
| [FIX-109](4-changes/bug-fixes/FIX-109-pipeline-config-refmatch-scope-guard.md) | pipeline config refmatch scope guard | ✅ 已修復（2026-06-18，靜態驗證通過；UI 端到端待 dev server 驗證） |
| [FIX-110](4-changes/bug-fixes/FIX-110-lineitem-charge-alias-hit-rate-audit.md) | lineitem charge alias hit rate audit | ✅ 已完成（9 條 aliases 已於 2026-07-15 冪等寫入 Azure DEV 並回讀驗證;可重現腳本 `prisma/ap… |
| [FIX-111](4-changes/bug-fixes/FIX-111-stage3-global-prompt-selection-nondeterminism-hkd-bypass.md) | stage3 global prompt selection nondeterminism hkd bypass | ✅ 程式碼 + 腳本完成 · ✅ Azure DEV 即時修正已套用（2026-07-16，讀回驗證 VERIFY_PASS）· ⏳ 程式… |
| [FIX-112](4-changes/bug-fixes/FIX-112-company-merge-missing-data-transfer.md) | company merge missing data transfer | ✅ 已完成（程式碼；存量資料回填另議） |
| [FIX-113](4-changes/bug-fixes/FIX-113-orphan-merge-data-backfill.md) | orphan merge data backfill | ✅ 已完成（本地 + Azure DEV 皆驗證無 CORE 存量孤兒，無需 WRITE；gated 腳本留作安全網工具） |
| [FIX-114](4-changes/bug-fixes/FIX-114-document-format-id-uuid-validation-blocks-format-scope.md) | document format id uuid validation blocks format scope | ✅ 已修復（本地；type-check / lint 通過） |

