param([string]$Uri)

$AppName = '__APP_NAME__'

Add-Type -AssemblyName System.Windows.Forms

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
            $path = $query['path']
            $msg = "URI    : $Uri`nScheme : $($parsed.Scheme)`nHost   : $($parsed.Host)`nPath   : $($parsed.AbsolutePath)`nQuery  : $($parsed.Query)"
            if ($path) { $msg += "`nFile   : $path" }
            [System.Windows.Forms.MessageBox]::Show(
                $msg, "$AppName Protocol Handler",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
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
