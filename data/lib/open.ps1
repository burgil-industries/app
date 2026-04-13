# Copyright (c) 2026 COMPUTER. Provided "AS IS" without warranty. See LICENSE for full terms.
# Handles file/folder open via file association and right-click menu.
# Posts to the running app's hook endpoint; falls back depending on file type.
param([string]$FilePath)

$AppName = '__APP_NAME__'

if (-not $FilePath) { exit }

# Determine the hook to fire based on file type
$isComputerFile = $FilePath -match '\.computer$'
$hook = if ($isComputerFile) { 'app:file-open' } else { 'app:open' }

# Try handing off to the running app
$handed = $false
if (Test-Path $FilePath) {
    try {
        $json = @{ hook = $hook; data = @{ path = $FilePath } } | ConvertTo-Json -Compress
        $wc = New-Object System.Net.WebClient
        $wc.Headers.Add("Content-Type", "application/json")
        $result = $wc.UploadString("http://127.0.0.1:53420/hook", $json)
        $handed = $true
    } catch {
        # App not running or request failed
    }
}

if (-not $handed) {
    if ($isComputerFile) {
        # App not running - show a notice instead of opening in notepad
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(
            "$AppName is not running.`n`nStart $AppName first, then open this file.",
            "$AppName",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    }
    # Non-.computer files: do nothing if app is not running
    # (right-click "Open with COMPUTER" only makes sense when the app is running)
}
