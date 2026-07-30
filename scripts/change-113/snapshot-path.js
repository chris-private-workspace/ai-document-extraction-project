/**
 * @fileoverview CHANGE-113：取得不會覆蓋既有檔案的快照路徑
 * @description
 *   踩過的坑（2026-07-30）：兩支寫入腳本各自用固定檔名寫快照，第二次套用
 *   （修正規則描述）把第一次的快照**覆蓋**掉了 —— 那份檔案本該保存「改成 FORMULA
 *   之前」的狀態，覆蓋後存的卻是改完之後的狀態。快照的唯一用途是還原，
 *   被覆蓋等於沒有。
 *
 *   做成共用模組而非各自複製：兩支腳本若各寫一份、其中一份漏了防覆蓋，
 *   失敗是**靜默**的（照樣寫檔、照樣成功、只是還原點沒了）。
 *
 * @module scripts/change-113/snapshot-path
 * @since CHANGE-113 階段二
 * @lastModified 2026-07-30
 */
const fs = require('fs')
const path = require('path')

/**
 * 取得一個尚未存在的快照檔路徑
 *
 * @param {string} dir - 快照目錄（不存在會建立）
 * @param {string} baseName - 檔名（含 .json）
 * @returns {string} 可安全寫入的絕對路徑；基礎檔名已存在時附加 `.2`、`.3`…
 */
function resolveSnapshotPath(dir, baseName) {
  fs.mkdirSync(dir, { recursive: true })

  const first = path.join(dir, baseName)
  if (!fs.existsSync(first)) return first

  const ext = path.extname(baseName)
  const stem = baseName.slice(0, baseName.length - ext.length)
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${stem}.${n}${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error(`快照檔名用盡（${baseName}）— 請先清理 ${dir}`)
}

module.exports = { resolveSnapshotPath }
