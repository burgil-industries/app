# app

> **Part of [burgil-industries/computer](https://github.com/burgil-industries/computer)**
> [`computer`](https://github.com/burgil-industries/computer) → **`app`** | [`installer`](https://github.com/burgil-industries/installer) | [`public`](https://github.com/burgil-industries/public) | [`plugins`](https://github.com/burgil-industries/plugins)

---

This repository contains the files that are **written to the user's machine** at install time. Nothing here runs during installation - these files are the application that gets installed.

## How it works

[`build.ps1`](https://github.com/burgil-industries/computer/blob/main/build.ps1) (in the root repo) processes [`installer/main.ps1`](https://github.com/burgil-industries/installer/blob/main/main.ps1), which contains:

```
{{EMBED_DIR:app}}
```

This directive reads every file under `app/` and encodes each one as a PowerShell here-string variable inside `public/install.ps1`. At install time, the installer script extracts those variables back to disk.

### File → variable → disk path

| Source file | Variable in install.ps1 | Written to |
|---|---|---|
| `data/lib/router.ps1` | `$FILE_DATA_LIB_ROUTER_PS1` | `<install_dir>/data/lib/router.ps1` |
| `data/src/app.js` | `$FILE_DATA_SRC_APP_JS` | `<install_dir>/data/src/app.js` |
| `data/plugins.json` | `$FILE_DATA_PLUGINS_JSON` | `<install_dir>/data/plugins.json` |
| `__APP_NAME__.cmd` | `$FILE___APP_NAME___CMD` | `<install_dir>/__APP_NAME__.cmd` |

Variable naming rule: `FILE_` + relative path with `/`, `\`, `.`, `-` replaced by `_`, uppercased.

## What to edit

Edit files here to change what ends up on the user's machine. Then run [`build.ps1`](https://github.com/burgil-industries/computer/blob/main/build.ps1) from the root repo to regenerate [`public/install.ps1`](https://github.com/burgil-industries/public/blob/main/install.ps1).

```powershell
# From the computer/ root:
.\build.ps1
```

Do **not** edit [`public/install.ps1`](https://github.com/burgil-industries/public/blob/main/install.ps1) directly - it is a generated file and will be overwritten.

## Layout

```
data/
  lib/          Runtime scripts (router, updater, uninstaller, startup hooks)
  src/          Application source (app.js, app.py, permissions.js)
  plugins.json  Installed plugins manifest
__APP_NAME__.cmd  Launcher stub (name filled in at install time)
LICENSE
```
