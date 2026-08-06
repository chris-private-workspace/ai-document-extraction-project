# Python Services - FastAPI 微服務

> **服務數量**: 2 個（`extraction` / `mapping`）
> **技術棧**: FastAPI + uvicorn + pydantic v2 + structlog
> **原始建立**: Epic 2（Story 2.2 / 2.3），最後實質修改 **2025-12-18**
> **最後更新**: 2026-08-06（首次建立本文件）
> **版本**: 1.0.0

---

## 🔴 先讀這一段：這兩個服務在現行主流程中的地位

本專案的**主要提取管線 V3.1 是 TypeScript 實作**（`src/services/extraction-v3/`），直接呼叫
Azure OpenAI 與 Azure Document Intelligence，**不經過這兩個 Python 服務**。

Python 服務屬於 **Epic 2 時期（2025-12）的架構**，其 TypeScript 呼叫端集中在 V2 時期的路徑：

| Python 服務 | 呼叫端 | 環境變數 |
|---|---|---|
| extraction（OCR） | `src/services/extraction.service.ts` → `/api/extraction`、`documents/upload/route.ts` | `OCR_SERVICE_URL`（預設 `http://localhost:8000`） |
| mapping | `src/services/mapping.service.ts` → `/api/mapping`<br>`src/services/identification/identification.service.ts` | `PYTHON_MAPPING_SERVICE_URL` / `MAPPING_SERVICE_URL`（預設 `http://localhost:8001`） |

⚠️ **動手前務必先查證當下是否真的有流量經過**，不要憑本文件或 docker-compose 有定義就假設它在線上運作：

```bash
# 1. 容器是否真的在跑（.claude/CLAUDE.md 的啟動流程只確認 postgres / pgadmin / azurite 三個）
docker-compose ps

# 2. 健康檢查是否通
curl http://localhost:8000/health
curl http://localhost:8001/health

# 3. 主線是否走 V3.1（走了就不經 Python）
#    查 ENABLE_UNIFIED_PROCESSOR 與 documents/upload/route.ts 的分支
```

修改這裡的程式碼前，先確認**要修的行為是否真的由這裡產生** —— 本專案有過「讀代碼證明可能、資料才證明實際」的教訓。

---

## 目錄結構

```
python-services/
├── extraction/                   # OCR 提取服務（port 8000）
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── .env.example
│   └── src/
│       ├── main.py               # FastAPI app + 路由
│       ├── ocr/
│       │   ├── azure_di.py       # Azure Document Intelligence 客戶端
│       │   └── processor.py      # DocumentProcessor
│       └── security/
│           └── safe_url.py       # SSRF 防護（assert_safe_url）
│
└── mapping/                      # Forwarder 識別 + 欄位映射服務（port 8001）
    ├── Dockerfile
    ├── requirements.txt
    ├── .env.example
    └── src/
        ├── main.py               # FastAPI app + 路由
        ├── identifier/
        │   └── matcher.py        # 基於模式的 Forwarder 識別
        └── mapper/
            ├── field_mapper.py   # 三層映射實作
            └── models.py         # pydantic 模型
```

---

## 服務 A — `extraction`（OCR 提取，port 8000）

| 端點 | 方法 | 用途 |
|------|------|------|
| `/extract/url` | POST | 從 URL 提取 |
| `/extract/file` | POST | 從上傳檔案提取 |
| `/health` | GET | 健康檢查 |

**依賴**：`azure-ai-documentintelligence` 1.0.2、`azure-identity`、`fastapi` 0.136.3、`structlog`

**環境變數**（見 `.env.example`）：`AZURE_DI_ENDPOINT`、`AZURE_DI_KEY`、`CORS_ORIGINS`、`DEBUG`

### 🔴 SSRF 防護

`/extract/url` 接受外部 URL，`src/security/safe_url.py` 的 `assert_safe_url()` 會擋掉內網位址，
拋出 `SsrfBlockedError`。**修改該端點時不可繞過這個檢查**（H4 Security constraint）。

---

## 服務 B — `mapping`（Forwarder 識別 + 欄位映射，port 8001）

| 端點 | 方法 | 用途 |
|------|------|------|
| `/identify` | POST | 從 OCR 文本識別 Forwarder |
| `/map-fields` | POST | 從 OCR 文本提取欄位值 |
| `/forwarders` | GET | 取得所有 Forwarder 列表 |
| `/health` | GET | 健康檢查 |

**提取方法**：`regex` / `keyword` / `position` / `azure_field`

### ⚠️ 這裡有一份**獨立的**信心度路由實作

`main.py` 的 docstring 記載兩組閾值：

| 用途 | 閾值 |
|------|------|
| Forwarder 識別 | ≥80% `AUTO_IDENTIFY`／50–79% `NEEDS_REVIEW`／<50% `UNIDENTIFIED` |
| 欄位提取 | ≥90% `AUTO_APPROVE`／70–89% `QUICK_REVIEW`／<70% `FULL_REVIEW` |

欄位提取那組**與 TypeScript 側的 90/70 一致**，但這是**另一份實作**，不會隨
`confidence-v3-1.service.ts` 或 `StageModelAssignment` 的調整而變動。

🔴 **改 TypeScript 側的路由邏輯時，這裡不會自動同步**；若此服務仍在流量路徑上，會造成兩套閾值並存。
（相關背景見 CLAUDE.md §信心度路由機制 與 FIX-148。）

### 🔴 用詞是 `Forwarder`，不是 `Company`

TypeScript 側已於 **REFACTOR-001** 把 `Forwarder` 全面改名為 `Company`，但 Python 服務**沒有跟進**。
本目錄的 `Forwarder` 對應 TS 側的 `Company`。跨語言比對時注意這個落差。

---

## Docker 配置（`docker-compose.yml`）

| 服務名 | 容器名 | 端口 | 依賴 |
|--------|--------|------|------|
| `ocr-extraction` | `ai-doc-extraction-ocr` | 8000:8000 | 無 |
| `forwarder-mapping` | `ai-doc-extraction-mapping` | 8001:8001 | `postgres`（service_healthy） |

兩者都設 `restart: unless-stopped` 與 healthcheck（30s 間隔、10s timeout、3 次重試）。

⚠️ `forwarder-mapping` 的 `DATABASE_URL` 在 compose 中寫死指向 **容器內** 的
`postgres:5432`，與本機開發用的 **5433** 不同 —— 這是容器網路內部位址，不是筆誤。

---

## 開發指令

```bash
# 只起這兩個服務
docker-compose up -d ocr-extraction forwarder-mapping

# 看 log
docker-compose logs -f ocr-extraction
docker-compose logs -f forwarder-mapping

# 重建（改了 requirements.txt 或 Dockerfile 後必須）
docker-compose build ocr-extraction
```

本機直接跑（不經 Docker）：

```bash
cd python-services/extraction
pip install -r requirements.txt
uvicorn src.main:app --reload --port 8000
```

---

## Hard Constraints 適用

| 約束 | 在本目錄的含意 |
|------|----------------|
| **H2** Dependency | 改 `requirements.txt` **需先 ask**（等同新增 npm 套件）。版本目前全部釘死（`==`），不要放寬成 `>=` |
| **H4** Security | `safe_url.py` 的 SSRF 防護不可繞過；`.env.example` 不得填入真實憑證 |
| **H1** Architecture | 改動信心度閾值或三層映射邏輯，即使只在 Python 側，仍觸發 H1 |

---

## 相關文檔

- [CLAUDE.md (根目錄)](../CLAUDE.md) - 項目總指南
- [src/services/CLAUDE.md](../src/services/CLAUDE.md) - TypeScript 服務層（含 V3.1 管線）
- [docker-compose.yml](../docker-compose.yml) - 容器定義
- `docs/02-architecture/` - 系統架構設計（Epic 2 時期的微服務設計）

---

**維護者**: Development Team
**最後更新**: 2026-08-06
**版本**: 1.0.0
