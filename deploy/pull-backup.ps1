# Забрать ночной снимок базы горничной с сервера на этот компьютер (копия вне сервера).
# Запуск: powershell -ExecutionPolicy Bypass -File deploy\pull-backup.ps1
# Каждый день сам — Планировщик заданий Windows с этой же командой (ключ SSH без пароля).
# Копии: maid-ГГГГ-ММ-ДД.sqlite в папке $Dest, хранятся последние $Keep. Поднять на сервере — deploy/restore.sh.
param(
  [string]$Dest = (Join-Path $env:USERPROFILE "Documents\Горничная — копии базы"),
  [string]$Server = "root@187.126.11.122",
  [string]$Key = (Join-Path $env:USERPROFILE ".ssh\maid_vps"),
  [int]$Keep = 30
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$ssh = @("-i", $Key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20")
& ssh @ssh $Server "cd /srv && docker compose cp maid:/data/snapshots/latest.sqlite /root/maid-latest.sqlite"
if ($LASTEXITCODE -ne 0) { throw "Сервер не отдал снимок (код $LASTEXITCODE)." }
$tmp = Join-Path $Dest "latest.tmp"
& scp @ssh "${Server}:/root/maid-latest.sqlite" $tmp
if ($LASTEXITCODE -ne 0) { throw "Не удалось скачать снимок (код $LASTEXITCODE)." }
# Файл SQLite начинается с «SQLite format 3».
$head = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($tmp)[0..14])
if ($head -ne "SQLite format 3") { Remove-Item $tmp; throw "Скачанное — не база SQLite." }
$file = Join-Path $Dest ("maid-{0:yyyy-MM-dd}.sqlite" -f (Get-Date))
Move-Item -Force $tmp $file
Get-ChildItem $Dest -Filter "maid-*.sqlite" | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item
Write-Output ("Копия базы: {0} ({1:N0} КБ)" -f $file, ((Get-Item $file).Length / 1KB))
