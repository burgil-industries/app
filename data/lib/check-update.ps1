# Check for Updates
$APP_NAME    = '__APP_NAME__'
$APP_VERSION = '__APP_VERSION__'
$UPDATE_URL  = '__UPDATE_URL__'

Add-Type -AssemblyName System.Windows.Forms
try {
    $wc   = New-Object System.Net.WebClient
    $json = $wc.DownloadString("$UPDATE_URL/latest.json") | ConvertFrom-Json
    $latest    = [System.Version]$json.version
    $installed = [System.Version]$APP_VERSION
    if ($latest -gt $installed) {
        [System.Windows.Forms.MessageBox]::Show(
            "$APP_NAME v$latest is available.`nYou have v$installed.`n`nDownload the update from the $APP_NAME website.",
            "Update Available",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    } else {
        [System.Windows.Forms.MessageBox]::Show(
            "$APP_NAME is up to date (v$APP_VERSION).",
            "No Updates",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    }
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "Unable to check for updates.`n`n$_",
        "Update Check Failed",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}
