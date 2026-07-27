#!/usr/bin/env node

/**
 * @fileoverview CHANGE/FIX 文檔一致性檢查 + 狀態索引生成
 * @description
 *   單一腳本兩種模式：
 *   - `--generate`：掃描 claudedocs/4-changes/ 全部 CHANGE/FIX，生成 claudedocs/STATUS.md
 *   - `--check`（預設）：執行一致性規則，並驗證 STATUS.md 與現況相符（lockfile 模式）
 *
 *   規則：
 *   - R1 編號唯一：同一類型的同一編號不得有兩個檔案（`b` 後綴變體如 FIX-026b 視為合法）
 *   - R2 狀態欄位：檔案必須有可解析的 `> **狀態**:` 行（BASELINE 內的舊檔豁免）
 *   - R3 索引同步：STATUS.md 必須等於當下重新生成的內容（防止索引過期）
 *
 *   設計理由：CHANGE/FIX 的完成狀態過去靠人手同步到多份索引，必然漂移。
 *   改為由檔案本身的狀態欄位單一來源推導，索引一律機器生成、CI 驗證。
 *
 * @module scripts/docs-consistency
 * @since CHANGE-104
 * @lastModified 2026-07-14
 *
 * @usage
 *   npm run docs:status   # 重新生成 STATUS.md
 *   npm run docs:check    # CI gate：檢查 R1-R3
 */

const fs = require('fs');
const path = require('path');

const CHANGES_DIR = path.join('claudedocs', '4-changes');
const DIRS = {
  CHANGE: path.join(CHANGES_DIR, 'feature-changes'),
  FIX: path.join(CHANGES_DIR, 'bug-fixes'),
};
const STATUS_FILE = path.join('claudedocs', 'STATUS.md');
const BASELINE_FILE = path.join('scripts', 'docs-consistency-baseline.json');

// 狀態分類
//
// 以狀態行「開頭的 emoji」為主判準 —— 純關鍵字比對太脆弱（「✅ Phase 5 完成」會被
// 「Phase」誤判為進行中；「📋 規劃中（待 CHANGE-055 Phase 1 評審）」亦然）。
// emoji 定調後，再套兩條修正規則處理實務上最常見的兩種語意落差。
const EMOJI_BUCKET = [
  { emoji: '✅', key: 'done' },
  { emoji: '🚧', key: 'inProgress' },
  { emoji: '🔧', key: 'inProgress' },
  { emoji: '🔍', key: 'inProgress' },
  { emoji: '🔬', key: 'inProgress' },
  { emoji: '🟡', key: 'inProgress' },
  { emoji: '⚠️', key: 'inProgress' },
  { emoji: '📋', key: 'notStarted' },
  { emoji: '⏳', key: 'notStarted' },
  { emoji: '⏸️', key: 'superseded' },
  { emoji: '⬆️', key: 'superseded' },
];

// 修正 1：標 ✅ 但仍有明確未完成的尾巴（如 FIX-108「已部署，但驗收仍待執行」）→ 部分完成
const DONE_BUT_PENDING = /尚未|仍待|待驗收|待驗證|待實測|待部署|待 ?E2E|未執行|未實作/;
// 修正 2：標 🚧 但只是「待修復／待實作」、無任何完成證據（如 FIX-060 stub）→ 其實未開始
const WIP_BUT_UNSTARTED = /待修復|待實作|規劃中/;
const HAS_PROGRESS_EVIDENCE = /Phase|階段|已完成|已實作|已修復|已部署|進行中|實施中/;

const BUCKET_LABELS = {
  notStarted: '未開始',
  inProgress: '進行中 / 部分完成',
  done: '已完成',
  superseded: '已取代 / 已升級',
};

function listDocs() {
  const docs = [];
  for (const [type, dir] of Object.entries(DIRS)) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const m = name.match(new RegExp(`^${type}-(\\d+)([a-z]?)-(.+)\\.md$`));
      if (!m) {
        docs.push({ type, file: path.join(dir, name), name, malformed: true });
        continue;
      }
      const content = fs.readFileSync(path.join(dir, name), 'utf8');
      const statusLine = content.split('\n').find((l) => /^>\s*\*\*狀態\*\*/.test(l));
      docs.push({
        type,
        num: parseInt(m[1], 10),
        suffix: m[2],
        file: path.join(dir, name).replace(/\\/g, '/'),
        name,
        title: m[3].replace(/-/g, ' '),
        statusLine: statusLine ? statusLine.replace(/^>\s*\*\*狀態\*\*\s*[:：]?\s*/, '').trim() : null,
      });
    }
  }
  return docs.sort((a, b) => (a.type === b.type ? a.num - b.num : a.type < b.type ? -1 : 1));
}

function classify(doc) {
  const line = doc.statusLine;
  if (!line) return 'unknown';

  // 取「位置最靠前」的 emoji，而非清單順序上第一個命中的 —— 狀態行內文常夾雜其他 emoji
  // （例：「🚧 進行中（Phase 1 = 組件 3 學習迴路 ✅ 已實作；Phase 2/3 待續）」開頭是 🚧，
  //  但內文的 ✅ 若被優先命中就會誤判為已完成）。
  const hit = EMOJI_BUCKET.map((e) => ({ e, idx: line.indexOf(e.emoji) }))
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.e)[0];
  if (!hit) return 'unknown';

  // 修正 1：✅ 但有未完成尾巴 → 進行中
  if (hit.key === 'done' && DONE_BUT_PENDING.test(line)) return 'inProgress';

  // 修正 2：🚧 但只寫「待修復／待實作」、無完成證據 → 未開始
  if (
    hit.key === 'inProgress' &&
    WIP_BUT_UNSTARTED.test(line) &&
    !HAS_PROGRESS_EVIDENCE.test(line)
  ) {
    return 'notStarted';
  }

  return hit.key;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return { missingStatus: [] };
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
}

/** 摘要狀態行：去掉 markdown 粗體與過長描述，只留可讀短語 */
function shortStatus(line) {
  if (!line) return '—';
  const plain = line.replace(/\*\*/g, '').replace(/\|/g, '/').trim();
  return plain.length > 70 ? plain.slice(0, 69) + '…' : plain;
}

function generate(docs) {
  const grouped = { notStarted: [], inProgress: [], done: [], superseded: [], unknown: [] };
  for (const d of docs) {
    if (d.malformed) continue;
    grouped[classify(d)].push(d);
  }

  const maxOf = (type) =>
    docs.filter((d) => d.type === type && !d.malformed).reduce((m, d) => Math.max(m, d.num), 0);

  const lines = [];
  lines.push('# CHANGE / FIX 狀態索引');
  lines.push('');
  lines.push('> 🤖 **本檔由 `npm run docs:status` 自動生成，請勿手動編輯**（手改會被 CI 的 `docs:check` 擋下）。');
  lines.push('> 狀態來源：各 CHANGE/FIX 檔案自身的 `> **狀態**:` 欄位 —— 改狀態請改該檔案，不要改這裡。');
  lines.push('');
  lines.push('## 編號');
  lines.push('');
  lines.push('| 類型 | 份數 | 目前最大編號 | 下一個可用 |');
  lines.push('|------|------|-------------|-----------|');
  for (const type of ['CHANGE', 'FIX']) {
    const count = docs.filter((d) => d.type === type && !d.malformed).length;
    const max = maxOf(type);
    lines.push(
      `| ${type} | ${count} | ${type}-${String(max).padStart(3, '0')} | **${type}-${String(max + 1).padStart(3, '0')}** |`
    );
  }
  lines.push('');

  const sections = [
    ['notStarted', '📋 未開始', '完全未動工的規劃。'],
    ['inProgress', '🚧 進行中 / 部分完成', '含「已實作待驗證」「Phase 1 完成、Phase 2 未做」等未收尾項。'],
    ['unknown', '❓ 狀態無法解析', '缺少 `> **狀態**:` 欄位或狀態文字無法歸類 —— 新檔不應出現在此區。'],
    ['superseded', '⏸️ 已取代 / 已升級', ''],
    ['done', '✅ 已完成', ''],
  ];

  for (const [key, heading, desc] of sections) {
    const items = grouped[key];
    lines.push(`## ${heading}（${items.length}）`);
    lines.push('');
    if (desc) {
      lines.push(`> ${desc}`);
      lines.push('');
    }
    if (items.length === 0) {
      lines.push('（無）');
      lines.push('');
      continue;
    }
    lines.push('| 編號 | 標題 | 狀態 |');
    lines.push('|------|------|------|');
    for (const d of items) {
      const id = `${d.type}-${String(d.num).padStart(3, '0')}${d.suffix}`;
      lines.push(`| [${id}](${path.relative('claudedocs', d.file).replace(/\\/g, '/')}) | ${d.title} | ${shortStatus(d.statusLine)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function check(docs) {
  const baseline = loadBaseline();
  const errors = [];
  const warnings = [];

  // R1 編號唯一
  const seen = new Map();
  for (const d of docs) {
    if (d.malformed) {
      warnings.push(`檔名不符命名規範，無法解析編號：${d.name}`);
      continue;
    }
    const id = `${d.type}-${String(d.num).padStart(3, '0')}${d.suffix}`;
    if (seen.has(id)) {
      errors.push(`R1 編號重複：${id} 同時存在於\n      - ${seen.get(id)}\n      - ${d.file}`);
    } else {
      seen.set(id, d.file);
    }
  }

  // R2 狀態欄位（baseline 內的舊檔豁免）
  const exempt = new Set(baseline.missingStatus || []);
  for (const d of docs) {
    if (d.malformed || d.statusLine) continue;
    if (exempt.has(d.file)) continue;
    errors.push(`R2 缺少可解析的狀態欄位（需有 \`> **狀態**: ...\` 行）：${d.file}`);
  }

  // 額外提示：baseline 內的檔案若已補上狀態欄位，可從 baseline 移除（ratchet 只能收緊）
  for (const f of exempt) {
    const d = docs.find((x) => x.file === f);
    if (d && d.statusLine) {
      warnings.push(`已補上狀態欄位，可從 baseline 移除：${f}`);
    }
  }

  // R3 索引同步（lockfile 模式）
  const expected = generate(docs);
  const actual = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8') : null;
  if (actual === null) {
    errors.push(`R3 ${STATUS_FILE} 不存在 —— 請執行 \`npm run docs:status\``);
  } else if (actual.replace(/\r\n/g, '\n').trim() !== expected.trim()) {
    errors.push(`R3 ${STATUS_FILE} 與現況不符（有 CHANGE/FIX 新增或狀態變更）—— 請執行 \`npm run docs:status\` 後一併提交`);
  }

  return { errors, warnings };
}

function main() {
  const mode = process.argv.includes('--generate') ? 'generate' : 'check';
  const docs = listDocs();

  if (mode === 'generate') {
    const out = generate(docs);
    fs.writeFileSync(STATUS_FILE, out + '\n', 'utf8');
    const counts = docs.reduce((acc, d) => {
      if (d.malformed) return acc;
      const k = classify(d);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    console.log(`✅ 已生成 ${STATUS_FILE}`);
    console.log(
      `   總計 ${docs.length} 份 | 未開始 ${counts.notStarted || 0} | 進行中 ${counts.inProgress || 0} | 已完成 ${counts.done || 0} | 已取代 ${counts.superseded || 0} | 無法解析 ${counts.unknown || 0}`
    );
    return;
  }

  const { errors, warnings } = check(docs);

  for (const w of warnings) console.log(`⚠️  ${w}`);
  for (const e of errors) console.error(`❌ ${e}`);

  console.log('');
  console.log(`掃描 ${docs.length} 份 CHANGE/FIX：${errors.length} 個錯誤、${warnings.length} 個警告`);

  if (errors.length > 0) {
    console.error('\n文檔一致性檢查未通過。');
    process.exit(1);
  }
  console.log('✅ 文檔一致性檢查通過。');
}

main();
