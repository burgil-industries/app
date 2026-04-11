# Check for Updates
$APP_NAME    = '__APP_NAME__'
$APP_VERSION = '__APP_VERSION__'
$UPDATE_URL  = '__UPDATE_URL__'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class UpdDark {
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
    public static void Enable(IntPtr hwnd) {
        int v = 1;
        DwmSetWindowAttribute(hwnd, 20, ref v, 4);
        DwmSetWindowAttribute(hwnd, 19, ref v, 4);
    }
}
"@

$C_BG     = [System.Drawing.Color]::FromArgb(13,  17,  23)
$C_CARD   = [System.Drawing.Color]::FromArgb(22,  27,  34)
$C_TEXT   = [System.Drawing.Color]::FromArgb(240, 246, 252)
$C_DIM    = [System.Drawing.Color]::FromArgb(139, 148, 158)
$C_ACCENT = [System.Drawing.Color]::FromArgb(121, 192, 255)
$C_BORDER = [System.Drawing.Color]::FromArgb(48,  54,  61)

function New-UpdBtn {
    param([string]$T, [int]$X, [int]$W,
          [System.Drawing.Color]$Bg, [System.Drawing.Color]$Fg,
          [System.Drawing.Color]$Border)
    $b = New-Object System.Windows.Forms.Button
    $b.Text      = $T
    $b.Location  = New-Object System.Drawing.Point($X, 108)
    $b.Size      = New-Object System.Drawing.Size($W, 32)
    $b.FlatStyle = "Flat"
    $b.FlatAppearance.BorderColor            = $Border
    $b.FlatAppearance.BorderSize             = 1
    $b.FlatAppearance.MouseOverBackColor     = [System.Drawing.Color]::FromArgb(38, 44, 52)
    $b.FlatAppearance.MouseDownBackColor     = [System.Drawing.Color]::FromArgb(24, 28, 34)
    $b.BackColor = $Bg
    $b.ForeColor = $Fg
    $b.Font      = New-Object System.Drawing.Font("Segoe UI", 9.5)
    $b.Cursor    = [System.Windows.Forms.Cursors]::Hand
    $b.TabStop   = $false
    return $b
}

try {
    $wc      = New-Object System.Net.WebClient
    $json    = $wc.DownloadString("$UPDATE_URL/latest.json") | ConvertFrom-Json
    $latest    = [System.Version]$json.version
    $installed = [System.Version]$APP_VERSION

    if ($latest -gt $installed) {
        $frm = New-Object System.Windows.Forms.Form
        $frm.Text            = "$APP_NAME - Update Available"
        $frm.ClientSize      = New-Object System.Drawing.Size(400, 152)
        $frm.StartPosition   = "CenterScreen"
        $frm.FormBorderStyle = "FixedDialog"
        $frm.MaximizeBox     = $false
        $frm.MinimizeBox     = $false
        $frm.BackColor       = $C_BG
        $frm.Add_Load({ [UpdDark]::Enable($frm.Handle) })

        $icoLbl           = New-Object System.Windows.Forms.Label
        $icoLbl.Text      = [char]0x2191   # up arrow
        $icoLbl.Font      = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold)
        $icoLbl.ForeColor = $C_ACCENT
        $icoLbl.BackColor = [System.Drawing.Color]::FromArgb(15, 30, 50)
        $icoLbl.Size      = New-Object System.Drawing.Size(48, 48)
        $icoLbl.Location  = New-Object System.Drawing.Point(20, 20)
        $icoLbl.TextAlign = "MiddleCenter"

        $lbl1           = New-Object System.Windows.Forms.Label
        $lbl1.Text      = "$APP_NAME v$latest is available"
        $lbl1.Font      = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
        $lbl1.ForeColor = $C_TEXT
        $lbl1.BackColor = [System.Drawing.Color]::Transparent
        $lbl1.Location  = New-Object System.Drawing.Point(82, 22)
        $lbl1.Size      = New-Object System.Drawing.Size(300, 26)

        $lbl2           = New-Object System.Windows.Forms.Label
        $lbl2.Text      = "You have v$installed. How would you like to update?"
        $lbl2.Font      = New-Object System.Drawing.Font("Segoe UI", 9)
        $lbl2.ForeColor = $C_DIM
        $lbl2.BackColor = [System.Drawing.Color]::Transparent
        $lbl2.Location  = New-Object System.Drawing.Point(82, 54)
        $lbl2.Size      = New-Object System.Drawing.Size(300, 18)

        $btnInstall = New-UpdBtn "Run Installer" 20  155 `
            ([System.Drawing.Color]::FromArgb(17, 36, 64)) $C_ACCENT `
            ([System.Drawing.Color]::FromArgb(56, 112, 200))
        $btnWeb     = New-UpdBtn "Open Website"  183 130 $C_CARD $C_TEXT $C_BORDER
        $btnCancel  = New-UpdBtn "Cancel"        321  59 $C_BG   $C_DIM  $C_BG

        $siteBase = $UPDATE_URL -replace '/updates.*$', ''
        $ps1Path  = Join-Path $PSScriptRoot "install.ps1"

        $btnInstall.Add_Click({
            $frm.Close()
            if (Test-Path $ps1Path) {
                Start-Process powershell.exe -ArgumentList "-NoProfile -File `"$ps1Path`""
            }
        })
        $btnWeb.Add_Click({
            $frm.Close()
            Start-Process $siteBase
        })
        $btnCancel.Add_Click({ $frm.Close() })

        $frm.Controls.AddRange(@($icoLbl, $lbl1, $lbl2, $btnInstall, $btnWeb, $btnCancel))
        $frm.ShowDialog() | Out-Null
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
