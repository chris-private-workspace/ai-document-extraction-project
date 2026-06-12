# FIX-075: package-lock.json 跨平台不完整導致 Linux npm ci 失敗

> **日期**: 2026-06-12
> **狀態**: ✅ 已修復（2026-06-12）
> **優先級**: High（production-blocking 隱患）
> **類型**: Bug（依賴 / 建置）
> **影響範圍**: `package-lock.json`、GitHub Actions Quality Checks workflow、Azure Docker build（`Dockerfile:49` `npm ci`）
> **來源**: Story 22-4 CI/CD pipeline 上線時，`quality-checks` workflow 的 `npm ci` 在 GitHub runner（Linux）失敗暴露
> **發現於**: PR #3（Story 22-4）的 Quality Checks 失敗

---

## 問題描述

Story 22-4 引入的 `quality-checks` workflow（type-check / lint / i18n）在 GitHub runner（Linux、node 20、npm 10.8.2）執行 `npm ci` 時失敗：

```
npm error code EUSAGE
npm error `npm ci` can only install packages when your package.json and
package-lock.json or npm-shrinkwrap.json are in sync.
npm error Missing: tree-sitter@0.21.1 from lock file
npm error Missing: tree-sitter@0.22.4 from lock file
npm error Missing: @swc/helpers@0.5.23 from lock file
```

三個 quality job 全卡在 `npm ci`，尚未跑到實際檢查。

### 弔詭現象

| 環境 | `npm ci` 結果 |
|------|--------------|
| 本地 Windows（npm 11.6.2）| ✅ exit 0（認為 lock 同步）|
| GitHub runner Linux（npm 10.8.2）| ❌ EUSAGE missing |

---

## 根本原因

`package-lock.json` 與 `package.json` 在 2026-06-11 的 **FIX-069（引入 `re2-wasm@^1.0.2`）** 一併更新時，是在 **Windows 環境** 用 `npm install` 生成的。該次生成的 lock **缺少 Linux 平台解析才會出現的 native / transitive 依賴條目**：

| 缺失條目 | 來源 |
|----------|------|
| `tree-sitter@0.21.1`（頂層）| re2-wasm 相關工具鏈 |
| `tree-sitter@0.22.4` | `@swagger-api/apidom-parser-adapter-yaml-1-2`（OpenAPI 解析）|
| `@swc/helpers@0.5.23` | `next-intl` |

`npm ci` 採嚴格 sync 檢查，Linux 解析依賴樹時需要這些條目但 lock 沒有 → EUSAGE。Windows 因平台解析路徑不同未觸發。

### 嚴重性

不僅影響 CI：`Dockerfile:49` 也用 `npm ci`（註解寫「確保 lockfile 一致性」），故**下次 Azure 重新 build image 會在同一步失敗**（production-blocking 隱患）。

---

## 修復方案

在 **Linux 環境（Docker node:20）** 重新執行 `npm install --package-lock-only`，補上 lock 缺失的跨平台條目（不改 `package.json`、不改任何已 pin 版本，僅補缺）：

```bash
docker run --rm -v "${PWD}:/app" -w /app node:20 npm install --package-lock-only
```

lock 變動：48 insertions / 34 deletions（僅補上 `tree-sitter` / `fsevents` / `@swc/helpers` 等平台條目）。

### 為何不在 Windows 修

Windows npm 解析不會產生 Linux 需要的條目，必須在 Linux 環境重建才能補齊。lock 為 v3 跨平台格式（superset），補上 Linux 條目不影響 Windows 安裝。

---

## 驗證

| 驗證項 | 結果 |
|--------|------|
| 乾淨 Linux 環境（模擬 CI）`npm ci --dry-run` | ✅ EXIT 0（不再報 missing）|
| Windows 本地 `npm ci --dry-run` | ✅ EXIT 0（未受影響）|
| `package.json` 是否變動 | ✅ 未動（僅補 lock 條目）|

---

## 影響

- PR #3（Story 22-4）的 quality-checks 重跑後將通過。
- Azure Docker build 的 `npm ci` production-blocking 隱患一併解除。

---

## 預防

後續若在 Windows 新增 / 升級含 native 依賴的套件，應在 Linux 環境（Docker / WSL / CI）重新生成 lock，或交由 Dependabot（Story 22-4 已配置）在 Linux 上產生更新 PR，避免跨平台 lock 不完整再次發生。
