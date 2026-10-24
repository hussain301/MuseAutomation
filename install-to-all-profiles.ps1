# ============================================================
#  Auto-inject Extension into ALL Chrome Profiles
# ============================================================

$extPath = "C:\Users\hussain\Desktop\muse-agent-orchestrator\extension"
$sh = New-Object -ComObject WScript.Shell

$searchFolders = @(
    "C:\Users\hussain\Desktop\profiles",
    "C:\Users\hussain\Desktop\profiles - Copy",
    "C:\Users\hussain\Desktop"
)

$totalUpdated = 0
$totalSkipped = 0

foreach ($folder in $searchFolders) {
    if (-not (Test-Path $folder)) { continue }

    $links = Get-ChildItem -Path $folder -Filter "*.lnk"
    foreach ($item in $links) {
        try {
            $lnk = $sh.CreateShortcut($item.FullName)
            
            # Check if it targets chrome.exe
            if ($lnk.TargetPath -match 'chrome\.exe') {
                $args = $lnk.Arguments

                if ($args -notmatch [regex]::Escape($extPath)) {
                    # Add --load-extension
                    $newArgs = "$args --load-extension=`"$extPath`""
                    $lnk.Arguments = $newArgs.Trim()
                    $lnk.Save()
                    $totalUpdated++
                } else {
                    $totalSkipped++
                }
            }
        } catch {
            Write-Warning "Failed to update $($item.Name): $($_.Exception.Message)"
        }
    }
}

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "✓ Done! Updated $totalUpdated Chrome profiles." -ForegroundColor Green
Write-Host "✓ Already had extension: $totalSkipped profiles." -ForegroundColor Yellow
Write-Host "Extension path: $extPath" -ForegroundColor Gray
Write-Host "=================================================" -ForegroundColor Cyan
