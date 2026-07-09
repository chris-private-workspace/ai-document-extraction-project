# Tech Specs 索引

> 各 Epic 的技術規格文件總覽。
> 🔴 **Epic 完成狀態的真實來源是 [`../sprint-status.yaml`](../sprint-status.yaml)** — 本索引僅供導覽。
> 最後更新：2026-07-09

---

## Epic 一覽

| Epic | 名稱 | 目錄 | 狀態 |
|------|------|------|------|
| 00 | Historical Data | [epic-00-historical-data](./epic-00-historical-data/) | ✅ 已完成 |
| 01 | Auth | [epic-01-auth](./epic-01-auth/) | ✅ 已完成 |
| 02 | AI Processing | [epic-02-ai-processing](./epic-02-ai-processing/) | ✅ 已完成 |
| 03 | Review Workflow | [epic-03-review-workflow](./epic-03-review-workflow/) | ✅ 已完成 |
| 04 | Mapping Rules | [epic-04-mapping-rules](./epic-04-mapping-rules/) | ✅ 已完成 |
| 05 | Forwarder Config | [epic-05-forwarder-config](./epic-05-forwarder-config/) | ✅ 已完成 |
| 06 | Multi-City | [epic-06-multi-city](./epic-06-multi-city/) | ✅ 已完成 |
| 07 | Reports & Dashboard | [epic-07-reports-dashboard](./epic-07-reports-dashboard/) | ✅ 已完成 |
| 08 | Audit & Compliance | [epic-08-audit-compliance](./epic-08-audit-compliance/) | ✅ 已完成 |
| 09 | Auto Retrieval | [epic-09-auto-retrieval](./epic-09-auto-retrieval/) | ✅ 已完成 |
| 10 | n8n Integration | [epic-10-n8n-integration](./epic-10-n8n-integration/) | ✅ 已完成 |
| 11 | External API | [epic-11-external-api](./epic-11-external-api/) | ✅ 已完成 |
| 12 | System Admin | [epic-12-system-admin](./epic-12-system-admin/) | ✅ 已完成 |
| 13 | Document Preview | [epic-13-document-preview](./epic-13-document-preview/) | ✅ 已完成 |
| 14 | Prompt Config | [epic-14-prompt-config](./epic-14-prompt-config/) | ✅ 已完成 |
| 15 | Unified Processing | [epic-15-unified-processing](./epic-15-unified-processing/) | ✅ 已完成 |
| 16 | Format Management | [epic-16-format-management](./epic-16-format-management/) | ✅ 已完成 |
| 17 | i18n | [epic-17-i18n](./epic-17-i18n/) | ✅ 已完成 |
| 18 | Local Auth | [epic-18-local-auth](./epic-18-local-auth/) | ✅ 已完成 |
| 19 | Template Matching | [epic-19-template-matching](./epic-19-template-matching/) | ✅ 已完成 |
| 20 | Reference Number Master | [epic-20-reference-number-master](./epic-20-reference-number-master/) | ✅ 已完成 |
| 21 | Exchange Rate Management | [epic-21-exchange-rate-management](./epic-21-exchange-rate-management/) | ✅ 已完成 |
| 22 | Enterprise Security | [epic-22-enterprise-security](./epic-22-enterprise-security/) | 🟡 Draft（未寫入 sprint-status） |
| 23 | **Multi-LLM Provider Integration** | [epic-23-multi-llm-provider](./epic-23-multi-llm-provider/) | 🟡 **Draft 提案**（本次新增） |

---

## 說明

- **Epic 00–21**：Phase 1 已完成（22 Epic / 157+ Stories）。狀態以 [`sprint-status.yaml`](../sprint-status.yaml) 為準。
- **Epic 22–23**：Draft 提案，**尚未寫入 `sprint-status.yaml`**、尚未進實作。
- **Epic 23（多 LLM Provider 整合）** 為當前進行中的規劃 —— 完整導覽、決策記錄（D1–D6）與設計審視見 **[epic-23-multi-llm-provider/README.md](./epic-23-multi-llm-provider/README.md)**，提案 PR [#96](https://github.com/chris-private-workspace/ai-document-extraction-project/pull/96)。

---

## 格式慣例

- 每個 Epic 一個 `epic-NN-kebab-name/` 目錄。
- Story 級規格：`tech-spec-story-N-M.md`。
- Epic 級提案 / 總覽（如 Epic 23）：`tech-spec-epic-NN-overview.md` + 目錄內 `README.md` 導覽。
