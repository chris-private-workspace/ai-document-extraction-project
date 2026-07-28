# =================================================================
# AI Document Extraction — 安裝 git hooks（Windows PowerShell）
# =================================================================
# 用途：
#   把 scripts/ 下的 hook 複製到 .git/hooks/。
#   `.git/` 不受版控（且在 CLAUDE.md §絕不 touch 清單內），所以 hook 本體
#   存放於 scripts/ 並由本腳本安裝 —— 變更本身不寫入 .git/，由開發者執行。
#
# 用法：
#   .\scripts\install-git-hooks.ps1
#
# 冪等：重複執行只會覆寫，不報錯。
#
# @since CHANGE-112 (2026-07-28)
# =================================================================

$ErrorActionPreference = 'Stop'

# 由自身位置推導專案根（避免硬編碼路徑）
$projectRoot = Split-Path $PSScriptRoot -Parent
$hooksDir = Join-Path $projectRoot '.git\hooks'

if (-not (Test-Path $hooksDir)) {
    Write-Host "  X 找不到 $hooksDir —— 這裡是 git repository 嗎？" -ForegroundColor Red
    exit 1
}

$hooks = @('pre-push')
$installed = 0

foreach ($hook in $hooks) {
    $src = Join-Path $PSScriptRoot $hook
    if (-not (Test-Path $src)) {
        Write-Host "  ! 來源不存在，跳過：$src" -ForegroundColor Yellow
        continue
    }

    $dst = Join-Path $hooksDir $hook

    # 🔴 必須寫成 LF + 無 BOM：
    #   Git for Windows 以自帶的 sh.exe 執行 hook。CRLF 會讓 shebang 變成
    #   `#!/bin/sh\r` 導致 exec 失敗；UTF-8 BOM 同樣會破壞 shebang。
    #   `.gitattributes` 的 `* text=auto eol=lf` 已保證工作樹是 LF，但此處
    #   仍明確正規化 —— 編輯器另存或跨工具複製都可能把它改回 CRLF，
    #   而這種失敗的錯誤訊息（exec format error / not found）極度不直觀。
    $content = (Get-Content $src -Raw) -replace "`r`n", "`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($dst, $content, $utf8NoBom)

    Write-Host "  OK 已安裝 $hook -> .git\hooks\$hook" -ForegroundColor Green
    $installed++
}

Write-Host ""
Write-Host "共安裝 $installed 個 hook。"
Write-Host "pre-push 會在推送前跑 npm run docs:check（約 11 秒）；略過用 git push --no-verify。"
