# ClipSync 桌面端安装包构建脚本
# 用法：pwsh -File scripts/build-desktop-installer.ps1
#
# 背景：Tauri 的 createUpdaterArtifacts=true 要求签名密钥，否则构建报错。
# 密钥在 ~/.tauri/clipsync.key（与 tauri.conf.json 的 pubkey 配对）。
# 本项目约定「桌面端由用户自行构建启动」，但**发版构建**可由 agent 代跑，
# 因为产物需要上传到服务器/GitHub Release 供官网下载。

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopDir = Join-Path $repoRoot 'src/desktop'
$keyPath = Join-Path $env:USERPROFILE '.tauri/clipsync.key'

if (-not (Test-Path $keyPath)) {
  throw "找不到更新签名私钥：$keyPath（createUpdaterArtifacts 必需）"
}

# Tauri 接受「密钥文件路径」或「密钥内容」两种形式，这里用路径
$env:TAURI_SIGNING_PRIVATE_KEY = $keyPath
# 密码留空：本地生成的密钥未设密码（若将来设了，改为从环境变量读，勿写死）
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
}

Write-Host "[build] 仓库：$repoRoot"
Write-Host "[build] 签名私钥：$keyPath"
Write-Host "[build] Rust: $(rustc --version)"

Push-Location $desktopDir
try {
  npm run tauri build 2>&1 | Tee-Object -FilePath (Join-Path $repoRoot 'tmp-desktop-build.log')
} finally {
  Pop-Location
}

Write-Host "[build] 产物："
$bundleDir = Join-Path $desktopDir 'src-tauri/target/release/bundle'
Get-ChildItem -Path $bundleDir -Recurse -File -Include *.exe, *.sig, *.msi, *.nsis.zip |
  Select-Object FullName, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } }
