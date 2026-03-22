param([string]$Uri)

$AppName = '__APP_NAME__'

Add-Type -AssemblyName System.Windows.Forms

try {
    $parsed = [System.Uri]$Uri
    $host_  = $parsed.Host.ToLower()
    $path_  = $parsed.AbsolutePath.TrimStart('/')
    $query  = [System.Web.HttpUtility]::ParseQueryString($parsed.Query)

    switch ($host_) {

        'install' {
            # ali://install/PLUGIN_ID?version=1.0.0&deps=dep1,dep2
            $pluginId = $path_
            $version  = $query['version']
            $deps     = $query['deps']

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

        'open' {
            # ali://open/PLUGIN_ID - launch an installed plugin
            $pluginId = $path_
            [System.Windows.Forms.MessageBox]::Show(
                "Opening plugin: $pluginId",
                "$AppName",
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
