param([string]$PresetInstallDir = "")

$AppName    = '__APP_NAME__'
$AppNameLow = $AppName.ToLower()
$RegPath    = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Single-instance guard
$_mutex = New-Object System.Threading.Mutex($false, "Global\$($AppName)_Uninstall_Mutex")
if (-not $_mutex.WaitOne(0, $false)) {
    [System.Windows.Forms.MessageBox]::Show(
        "$AppName Uninstaller is already running.", "$AppName Uninstaller",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    $_mutex.Dispose()
    exit
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class UninstDark {
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
    public static void Enable(IntPtr hwnd) {
        int v = 1;
        DwmSetWindowAttribute(hwnd, 20, ref v, 4);
        DwmSetWindowAttribute(hwnd, 19, ref v, 4);
    }
}
public static class UninstShell {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
"@

$props      = Get-ItemProperty $RegPath -ErrorAction SilentlyContinue
$InstallDir = if ($PresetInstallDir) { $PresetInstallDir } `
              elseif ($props)        { $props.InstallLocation } `
              else                   { Split-Path $PSScriptRoot -Parent }

# Self-relaunch from %TEMP%: releases CMD's working-directory handle on the
# install folder so Remove-Item can delete it cleanly.
if (-not $PresetInstallDir) {
    $src        = if ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $PSCommandPath }
    $tempScript = "$env:TEMP\$($AppNameLow)_uninstall_run.ps1"
    Copy-Item $src $tempScript -Force
    $vbs = "$env:TEMP\$($AppNameLow)_uninstall_run.vbs"
    $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$tempScript`" `"$InstallDir`""
    $cmdVbs = $cmd.Replace('"', '""')
    $vbsContent = @"
Set sh = CreateObject("WScript.Shell")
temp = sh.ExpandEnvironmentStrings("%TEMP%")
sh.CurrentDirectory = temp
sh.Run "$cmdVbs", 0, False
"@
    [System.IO.File]::WriteAllText($vbs, $vbsContent, [System.Text.Encoding]::ASCII)
    Start-Process wscript.exe -WorkingDirectory $env:TEMP -ArgumentList "`"$vbs`""
    exit
}

# Wait for the parent CMD process to fully exit before we attempt deletion
Start-Sleep -Milliseconds 600
try { Set-Location -Path (Split-Path $InstallDir -Parent) } catch { Set-Location -Path $env:TEMP }

$C_BG      = [System.Drawing.Color]::FromArgb(13,  17,  23)
$C_CARD    = [System.Drawing.Color]::FromArgb(22,  27,  34)
$C_TEXT    = [System.Drawing.Color]::FromArgb(240, 246, 252)
$C_DIM     = [System.Drawing.Color]::FromArgb(139, 148, 158)
$C_DANGER  = [System.Drawing.Color]::FromArgb(248, 81,  73)
$C_SUCCESS = [System.Drawing.Color]::FromArgb(63,  185, 80)
$C_BORDER  = [System.Drawing.Color]::FromArgb(48,  54,  61)
$script:uninstallDone = $false

$frm                 = New-Object System.Windows.Forms.Form
$frm.Text            = "Uninstall $AppName"
$frm.ClientSize      = New-Object System.Drawing.Size(420, 210)
$frm.StartPosition   = "CenterScreen"
$frm.FormBorderStyle = "FixedDialog"
$frm.MaximizeBox     = $false
$frm.MinimizeBox     = $false
$frm.BackColor       = $C_BG
$frm.Icon            = [System.Drawing.SystemIcons]::Shield

$frm.Add_Load({ [UninstDark]::Enable($frm.Handle) })

$icoLbl           = New-Object System.Windows.Forms.Label
$icoLbl.Text      = "!"
$icoLbl.Font      = New-Object System.Drawing.Font("Segoe UI", 22, [System.Drawing.FontStyle]::Bold)
$icoLbl.ForeColor = $C_DANGER
$icoLbl.BackColor = [System.Drawing.Color]::FromArgb(60, 15, 10)
$icoLbl.Size      = New-Object System.Drawing.Size(48, 48)
$icoLbl.Location  = New-Object System.Drawing.Point(24, 24)
$icoLbl.TextAlign = "MiddleCenter"

$lbl1           = New-Object System.Windows.Forms.Label
$lbl1.Text      = "Uninstall $AppName?"
$lbl1.Font      = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$lbl1.ForeColor = $C_TEXT
$lbl1.BackColor = [System.Drawing.Color]::Transparent
$lbl1.Location  = New-Object System.Drawing.Point(84, 24)
$lbl1.Size      = New-Object System.Drawing.Size(310, 28)

$lbl2           = New-Object System.Windows.Forms.Label
$lbl2.Text      = $InstallDir
$lbl2.Font      = New-Object System.Drawing.Font("Segoe UI", 9)
$lbl2.ForeColor = $C_DIM
$lbl2.BackColor = [System.Drawing.Color]::Transparent
$lbl2.Location  = New-Object System.Drawing.Point(84, 58)
$lbl2.Size      = New-Object System.Drawing.Size(310, 18)

$lbl3           = New-Object System.Windows.Forms.Label
$lbl3.Text      = "All files and registry entries will be removed. This cannot be undone."
$lbl3.Font      = New-Object System.Drawing.Font("Segoe UI", 9)
$lbl3.ForeColor = $C_DIM
$lbl3.BackColor = [System.Drawing.Color]::Transparent
$lbl3.Location  = New-Object System.Drawing.Point(24, 92)
$lbl3.Size      = New-Object System.Drawing.Size(372, 36)

function New-FlatBtn {
    param([string]$T, [int]$X, [System.Drawing.Color]$Bg, [System.Drawing.Color]$Fg)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $T; $b.Location = New-Object System.Drawing.Point($X, 158)
    $b.Size = New-Object System.Drawing.Size(116, 34)
    $b.FlatStyle = "Flat"
    $b.FlatAppearance.BorderColor = $C_BORDER
    $b.FlatAppearance.BorderSize  = 1
    $b.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(38, 44, 52)
    $b.FlatAppearance.MouseDownBackColor = [System.Drawing.Color]::FromArgb(24, 28, 34)
    $b.BackColor = $Bg; $b.ForeColor = $Fg
    $b.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    $b.TabStop = $false
    return $b
}

$btnYes = New-FlatBtn "Uninstall" 164 ([System.Drawing.Color]::FromArgb(58,15,12)) $C_DANGER
$btnNo  = New-FlatBtn "Cancel"    286 $C_CARD $C_TEXT

$frm.Controls.AddRange(@($icoLbl, $lbl1, $lbl2, $lbl3, $btnYes, $btnNo))

$btnNo.Add_Click({
    if ($script:uninstallDone -and (Test-Path $InstallDir)) {
        Start-Process cmd.exe -WorkingDirectory $env:TEMP -ArgumentList "/c for /l %i in (1,1,6) do (rd /s /q `"$InstallDir`" >nul 2>&1 & if not exist `"$InstallDir`" exit /b 0 & ping localhost -n 2 >nul)" -WindowStyle Hidden
    }
    $frm.Close()
})
$btnYes.Add_Click({
    $btnYes.Visible = $false; $btnNo.Visible = $false
    $lbl1.Text = "Removing..."
    [System.Windows.Forms.Application]::DoEvents()

    Remove-Item -Path "HKCU:\SOFTWARE\Classes\.$AppNameLow\ShellNew"                  -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "HKCU:\SOFTWARE\Classes\.$AppNameLow"                           -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "HKCU:\SOFTWARE\Classes\$AppName.File"                          -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "HKCU:\SOFTWARE\Classes\$AppNameLow"                            -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $RegPath                                                         -Recurse -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" -Name $AppName -ErrorAction SilentlyContinue
    Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\$AppName.lnk" -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "HKCU:\SOFTWARE\Classes\*\shell\$AppName"                -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path        "HKCU:\SOFTWARE\Classes\Directory\shell\$AppName"        -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path        "HKCU:\SOFTWARE\Classes\Directory\Background\shell\$AppName" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:APPDATA\Microsoft\Windows\SendTo\$AppName.lnk"                  -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\$AppName.lnk"     -Force -ErrorAction SilentlyContinue
    $curPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $newPath = ($curPath -split ";" | Where-Object { $_ -and $_ -ne $InstallDir -and $_ -ne "$InstallDir\data" }) -join ";"
    if ($newPath -ne $curPath) { [Environment]::SetEnvironmentVariable("Path", $newPath, "User") }
    $sc = "$env:USERPROFILE\Desktop\$AppName.lnk"
    if (Test-Path $sc) { Remove-Item $sc -Force -ErrorAction SilentlyContinue }

    # Flush Explorer's icon/shell cache now that all registry associations are gone
    [UninstShell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 800

    # Clear attributes on everything recursively so Remove-Item can delete cleanly
    Get-ChildItem $InstallDir -Recurse -Force -ErrorAction SilentlyContinue |
        ForEach-Object { try { $_.Attributes = [System.IO.FileAttributes]::Normal } catch {} }
    $dirItem = Get-Item $InstallDir -Force -ErrorAction SilentlyContinue
    if ($dirItem) { $dirItem.Attributes = [System.IO.FileAttributes]::Normal }

    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $InstallDir) {
        try { [System.IO.Directory]::Delete($InstallDir, $true) } catch {}
    }
    if (Test-Path $InstallDir) {
        Start-Process cmd.exe -WorkingDirectory $env:TEMP -ArgumentList "/c rd /s /q `"$InstallDir`"" -Wait -WindowStyle Hidden
    }
    if (Test-Path $InstallDir) {
        Start-Process cmd.exe -WorkingDirectory $env:TEMP -ArgumentList "/c for /l %i in (1,1,6) do (rd /s /q `"$InstallDir`" >nul 2>&1 & if not exist `"$InstallDir`" exit /b 0 & ping localhost -n 2 >nul)" -Wait -WindowStyle Hidden
    }

    $icoLbl.Text      = [char]0x2713
    $icoLbl.ForeColor = $C_SUCCESS
    $icoLbl.BackColor = [System.Drawing.Color]::FromArgb(15, 40, 20)
    $lbl1.Text        = "$AppName uninstalled."
    $lbl1.ForeColor   = $C_SUCCESS
    $lbl2.Text        = "All files and registry entries have been removed."
    $lbl3.Text        = ""
    $btnNo.Text       = "Close"
    $btnNo.Visible    = $true
    $script:uninstallDone = $true
})
$frm.ShowDialog() | Out-Null
