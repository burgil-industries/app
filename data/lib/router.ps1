# Copyright (c) 2026 COMPUTER. Provided "AS IS" without warranty. See LICENSE for full terms.
param([string]$Uri)

$AppName = '__APP_NAME__'

Add-Type -AssemblyName System.Windows.Forms

# Fire a hook on the running app via the heartbeat server (port 53420).
# Non-blocking, best-effort - silently ignored if the app is not running.
function Fire-Hook([string]$HookName, [hashtable]$Data = @{}) {
    try {
        $json = @{ hook = $HookName; data = $Data } | ConvertTo-Json -Compress
        $wc = New-Object System.Net.WebClient
        $wc.Headers.Add("Content-Type", "application/json")
        $wc.UploadString("http://127.0.0.1:53420/hook", $json) | Out-Null
    } catch {}
}

# Permission descriptions for human-readable display
$PermDescriptions = @{
    'fs.read'        = 'Read files from your computer'
    'fs.write'       = 'Write files to your computer'
    'net.listen'     = 'Start a local server'
    'net.connect'    = 'Connect to the internet'
    'system.exec'    = 'Run system commands'
    'ctx.provide'    = 'Provide services to other plugins'
    'ctx.broadcast'  = 'Send messages to all connected clients'
}

function Get-PermissionDescription([string]$perm) {
    $base = ($perm -split ':')[0]
    $scope = if ($perm.Contains(':')) { ($perm -split ':', 2)[1] } else { $null }
    $desc = $PermDescriptions[$base]
    if (-not $desc) { $desc = $perm }
    if ($scope -and $scope -ne '${dataDir}') {
        $desc += " ($scope)"
    }
    return $desc
}

function Format-PermissionList([string[]]$permissions) {
    if (-not $permissions -or $permissions.Count -eq 0) {
        return "  (none)"
    }
    $lines = @()
    foreach ($p in $permissions) {
        $lines += "  - $(Get-PermissionDescription $p)"
    }
    return ($lines -join "`n")
}

try {
    $parsed = [System.Uri]$Uri
    $host_  = $parsed.Host.ToLower()
    $path_  = $parsed.AbsolutePath.TrimStart('/')
    $queryString = $parsed.Query.TrimStart('?')
    $query = @{}
    if ($queryString) {
        foreach ($part in $queryString.Split('&')) {
            $kv = $part.Split('=', 2)
            $key = [System.Uri]::UnescapeDataString($kv[0])
            $val = if ($kv.Count -gt 1) { [System.Uri]::UnescapeDataString($kv[1]) } else { '' }
            $query[$key] = $val
        }
    }

    # Fire protocol hook for every incoming URI
    Fire-Hook 'app:protocol' @{ uri = $Uri; host = $host_; path = $path_; query = $query }

    switch ($host_) {

        'install' {
            # computer://install/PLUGIN_ID?version=1.0.0&deps=dep1,dep2&permissions=fs.read,net.connect
            $pluginId = $path_
            $version  = $query['version']
            $deps     = $query['deps']
            $perms    = $query['permissions']

            if (-not $pluginId) {
                [System.Windows.Forms.MessageBox]::Show(
                    'No plugin ID specified.',
                    "$AppName - Install",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
                break
            }

            $msg = "Plugin: $pluginId"
            if ($version) { $msg += "`nVersion: $version" }
            if ($deps)    { $msg += "`nRequires: $($deps -replace ',', ', ')" }

            # Show permissions if provided
            if ($perms) {
                $permList = $perms -split ','
                $msg += "`n`nPermissions requested:`n$(Format-PermissionList $permList)"
            }

            $msg += "`n`nInstall this plugin?"

            $result = [System.Windows.Forms.MessageBox]::Show(
                $msg,
                "$AppName - Install Plugin",
                [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Question)

            if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
                Fire-Hook 'app:before-install' @{ pluginId = $pluginId; version = $version }
                # Placeholder: actual plugin installation logic goes here
                [System.Windows.Forms.MessageBox]::Show(
                    "Plugin '$pluginId' installed successfully.",
                    "$AppName - Install Plugin",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
            }
        }

        'install-package' {
            # computer://install-package/PACKAGE_ID?plugins=core,ui,settings
            $packageId = $path_
            $pluginsList = $query['plugins']

            if (-not $packageId) {
                [System.Windows.Forms.MessageBox]::Show(
                    'No package ID specified.',
                    "$AppName - Install Package",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
                break
            }

            $plugins = if ($pluginsList) { $pluginsList -split ',' } else { @() }

            $msg = "Package: $packageId"
            $msg += "`nPlugins: $($plugins -join ', ')"
            $msg += "`n`nInstall all $($plugins.Count) plugins in this package?"

            $result = [System.Windows.Forms.MessageBox]::Show(
                $msg,
                "$AppName - Install Package",
                [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Question)

            if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
                $installed = @()
                foreach ($p in $plugins) {
                    # Placeholder: actual plugin installation logic goes here
                    $installed += $p
                }
                [System.Windows.Forms.MessageBox]::Show(
                    "Package '$packageId' installed successfully.`n`nPlugins installed: $($installed -join ', ')",
                    "$AppName - Install Package",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
            }
        }

        'open' {
            $filePath = $query['path']
            if ($filePath -and $filePath -match '\.computer$' -and (Test-Path $filePath)) {
                # Fire file-open hook
                Fire-Hook 'app:file-open' @{ path = $filePath }

                # Validate .computer file
                $fileName = [System.IO.Path]::GetFileName($filePath)
                $rawContent = $null
                $jsonObj = $null
                $errors = @()

                try {
                    $rawContent = Get-Content $filePath -Raw -ErrorAction Stop
                } catch {
                    $errors += "Cannot read file: $_"
                }

                if ($rawContent -ne $null) {
                    try {
                        $jsonObj = $rawContent | ConvertFrom-Json -ErrorAction Stop
                    } catch {
                        $errors += "Invalid JSON: $_"
                    }
                }

                if ($jsonObj -ne $null) {
                    $isBundle = $fileName -eq 'bundle.computer'
                    $isPlugin = $fileName -eq 'plugin.computer'

                    if (-not $isBundle -and -not $isPlugin) {
                        # Detect type from content
                        if ($jsonObj.plugins) { $isBundle = $true }
                        elseif ($jsonObj.main -or $jsonObj.dependencies) { $isPlugin = $true }
                        else { $isPlugin = $true }  # default
                    }

                    if ($isBundle) {
                        if (-not $jsonObj.id -or $jsonObj.id -isnot [string] -or -not $jsonObj.id.Trim()) {
                            $errors += '"id" is required and must be a non-empty string'
                        } elseif ($jsonObj.id -notmatch '^[a-z0-9][a-z0-9\-_]*$') {
                            $errors += "`"id`" `"$($jsonObj.id)`" is invalid - use lowercase letters, digits, hyphens, or underscores"
                        }
                        if (-not $jsonObj.name -or $jsonObj.name -isnot [string] -or -not $jsonObj.name.Trim()) {
                            $errors += '"name" is required and must be a non-empty string'
                        }
                        if (-not $jsonObj.plugins -or $jsonObj.plugins.Count -eq 0) {
                            $errors += '"plugins" must be a non-empty array of plugin IDs'
                        } elseif ($jsonObj.plugins) {
                            for ($i = 0; $i -lt $jsonObj.plugins.Count; $i++) {
                                $p = $jsonObj.plugins[$i]
                                if (-not $p -or $p -isnot [string] -or -not $p.Trim()) {
                                    $errors += "`"plugins[$i]`" must be a non-empty string plugin ID"
                                }
                            }
                        }
                    } else {
                        # Plugin validation
                        if (-not $jsonObj.id -or $jsonObj.id -isnot [string] -or -not $jsonObj.id.Trim()) {
                            $errors += '"id" is required and must be a non-empty string'
                        } elseif ($jsonObj.id -notmatch '^[a-z0-9][a-z0-9\-_]*$') {
                            $errors += "`"id`" `"$($jsonObj.id)`" is invalid - use lowercase letters, digits, hyphens, or underscores"
                        }
                        if (-not $jsonObj.name -or $jsonObj.name -isnot [string] -or -not $jsonObj.name.Trim()) {
                            $errors += '"name" is required and must be a non-empty string'
                        }
                        if ($jsonObj.version -ne $null -and $jsonObj.version -isnot [string]) {
                            $errors += '"version" must be a string'
                        }
                        if ($jsonObj.dependencies -ne $null -and $jsonObj.dependencies -is [array]) {
                            $errors += '"dependencies" must be an object, e.g. { "core": "*" }'
                        }
                        if ($jsonObj.permissions -ne $null -and $jsonObj.permissions -isnot [array]) {
                            $errors += '"permissions" must be an array of strings'
                        }
                        # Check main file exists
                        $dir = [System.IO.Path]::GetDirectoryName($filePath)
                        $mainFile = if ($jsonObj.main) { $jsonObj.main } else { "index.js" }
                        $mainPath = Join-Path $dir $mainFile
                        if (-not (Test-Path $mainPath)) {
                            $errors += "Main file `"$mainFile`" not found in plugin directory"
                        }
                    }
                }

                $type = if ($isBundle) { "Bundle" } else { "Plugin" }

                if ($errors.Count -gt 0) {
                    $msg = "$type manifest has $($errors.Count) error(s):`n`n"
                    foreach ($e in $errors) { $msg += "  - $e`n" }
                    $msg += "`nWould you like to open the file in your code editor to fix it?"
                    $result = [System.Windows.Forms.MessageBox]::Show(
                        $msg, "$AppName - Invalid $type",
                        [System.Windows.Forms.MessageBoxButtons]::YesNo,
                        [System.Windows.Forms.MessageBoxIcon]::Warning)
                    if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
                        Start-Process $filePath
                    }
                } else {
                    $msg = "$type manifest is valid.`n`n"
                    $msg += "ID: $($jsonObj.id)`n"
                    $msg += "Name: $($jsonObj.name)`n"
                    if ($jsonObj.version) { $msg += "Version: $($jsonObj.version)`n" }
                    if ($jsonObj.description) { $msg += "Description: $($jsonObj.description)`n" }
                    if ($isBundle) {
                        $msg += "Plugins: $($jsonObj.plugins -join ', ')`n"
                    } else {
                        if ($jsonObj.permissions) { $msg += "`nPermissions:`n$(Format-PermissionList $jsonObj.permissions)`n" }
                        if ($jsonObj.dependencies) {
                            $deps = ($jsonObj.dependencies | Get-Member -MemberType NoteProperty | ForEach-Object { $_.Name }) -join ', '
                            if ($deps) { $msg += "Dependencies: $deps`n" }
                        }
                    }
                    $msg += "`nWould you like to open the file in your code editor?"
                    $result = [System.Windows.Forms.MessageBox]::Show(
                        $msg, "$AppName - $type Manifest",
                        [System.Windows.Forms.MessageBoxButtons]::YesNo,
                        [System.Windows.Forms.MessageBoxIcon]::Information)
                    if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
                        Start-Process $filePath
                    }
                }
            } else {
                $msg = "URI    : $Uri`nScheme : $($parsed.Scheme)`nHost   : $($parsed.Host)`nPath   : $($parsed.AbsolutePath)`nQuery  : $($parsed.Query)"
                if ($filePath) { $msg += "`nFile   : $filePath" }
                [System.Windows.Forms.MessageBox]::Show(
                    $msg, "$AppName Protocol Handler",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
            }
        }

        default {
            # Show raw URI info for unrecognised commands
            $msg = "URI    : $Uri`nScheme : $($parsed.Scheme)`nHost   : $($parsed.Host)`nPath   : $($parsed.AbsolutePath)`nQuery  : $($parsed.Query)"
            [System.Windows.Forms.MessageBox]::Show(
                $msg, "$AppName Protocol Handler",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        }
    }
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "Failed to handle URI: $Uri`n$_",
        "$AppName Protocol Handler",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}
