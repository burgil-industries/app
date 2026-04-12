// Copyright (c) 2026 COMPUTER. Provided "AS IS" without warranty. See LICENSE for full terms.
'use strict';
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const { exec, execFileSync, spawn } = require('child_process');

// -- Feature flags: broad (unscoped) permissions that require an explicit opt-in
// Maps permission prefix -> config key that must be true to allow it.
const FEATURE_GATED_PERMS = {
    'system.exec'  : 'features.unrestricted_exec',
    'net.connect'  : 'features.unrestricted_network',
};

// Safe defaults shipped with the app - all advanced features disabled.
const FEATURE_FLAG_DEFAULTS = {
    'features.experimental'       : false,
    'features.unrestricted_exec'  : false,
    'features.unrestricted_network': false,
};

// -- Permission metadata -------------------------------------------------------
const PERM_DESCRIPTIONS = {
    'fs.read'        : 'Read files from your computer',
    'fs.write'       : 'Write files to your computer',
    'net.listen'     : 'Start a local server on your machine',
    'net.connect'    : 'Connect to the internet',
    'system.exec'    : 'Run system commands',
    'ctx.provide'    : 'Provide services to other plugins',
    'ctx.broadcast'  : 'Send messages to all connected clients',
    'vm.manage'      : 'Manage plugins (enable, disable, reload)',
};

// -- Plugin VM -----------------------------------------------------------------
class PluginVM {
    /**
     * @param {{
     *   pluginsDir : string,
     *   dataDir    : string,
     *   appName    : string,
     *   appVersion : string,
     * }} options
     */
    constructor(options) {
        this.pluginsDir   = options.pluginsDir;
        this.dataDir      = options.dataDir;
        this.appName      = options.appName    || 'Computer';
        this.appVersion   = options.appVersion || '1.0.0';
        this._services         = new Map();   // name -> value (provided by plugins)
        this._serviceProviders = new Map();   // service name -> pluginId that provided it
        this._loaded      = [];          // plugin/bundle IDs loaded in this session
        this._pluginMetas = new Map();   // pluginId -> plugin.json contents
        this._syncing     = false;       // mutex: prevents concurrent _syncPlugins calls
    }

    // -- Feature flags (read from data/config.json, same file as core's Config) -

    _readFeatureFlags() {
        const cfgFile = path.join(this.dataDir, 'config.json');
        let stored = {};
        try { stored = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) {}
        const flags = {};
        for (const [k, def] of Object.entries(FEATURE_FLAG_DEFAULTS)) {
            flags[k] = k in stored ? stored[k] : def;
        }
        return flags;
    }

    // -- Plugin cache (data/plugins-cache.json) --------------------------------
    // Schema: { [id]: { status: "loaded"|"denied"|"error"|"removed"|"disabled", folder?, type? } }

    _cacheFile() { return path.join(this.dataDir, 'plugins-cache.json'); }

    _loadCache() {
        try { return JSON.parse(fs.readFileSync(this._cacheFile(), 'utf8')); }
        catch (_) { return {}; }
    }

    _saveCache(cache) {
        fs.mkdirSync(this.dataDir, { recursive: true });
        fs.writeFileSync(this._cacheFile(), JSON.stringify(cache, null, 2));
    }

    // -- Permission persistence ------------------------------------------------

    _permsFile(pluginId) {
        return path.join(this.dataDir, 'permissions', `${pluginId}.json`);
    }

    _loadSavedPerms(pluginId) {
        try {
            return new Set(JSON.parse(fs.readFileSync(this._permsFile(pluginId), 'utf8')));
        } catch (_) {
            return null; // not yet granted
        }
    }

    _savePerms(pluginId, perms) {
        const dir = path.join(this.dataDir, 'permissions');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this._permsFile(pluginId), JSON.stringify([...perms], null, 2));
    }

    // -- Permission dialog (Edge --app + local HTTP server) --------------------

    _findEdge() {
        const candidates = [
            path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env['ProgramFiles']       || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env['LOCALAPPDATA']       || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ];
        return candidates.find(p => { try { fs.accessSync(p); return true; } catch (_) { return false; } }) || null;
    }

    _openBrowser(url, w = 420, h = 380) {
        const edge = this._findEdge();
        if (edge) {
            // A dedicated profile dir forces Edge to open a fresh window that
            // actually respects --window-size (ignored when a profile is already open).
            const profileDir = path.join(this.dataDir, 'edge-dialog-profile');
            spawn(edge, [
                `--app=${url}`,
                `--window-size=${w},${h}`,
                `--user-data-dir=${profileDir}`,
                '--no-first-run',
                '--disable-extensions',
                '--disable-default-apps',
                '--disable-sync',
                '--no-default-browser-check',
            ], { detached: true, stdio: 'ignore' }).unref();
        } else {
            exec(`cmd /c start "" "${url}"`);
        }
    }

    /**
     * Show the permission dialog and resolve when the user responds or closes.
     *
     * Window-close detection uses a persistent SSE connection (/sse) instead of
     * the socket close event on the GET / request.  Edge closes the keep-alive
     * HTTP connection right after loading the page, which caused the old
     * req.socket 'close' handler to fire immediately (before the user clicked
     * anything).  The SSE stream stays alive for the entire lifetime of the page.
     *
     * @param {object} dialogData  Fully-formed data object injected into dialog.html
     * @param {number} [winW=420]
     * @param {number} [winH=380]
     * @returns {Promise<boolean>} true = granted, false = denied/closed
     */
    _showPermDialog(dialogData, winW = 420, winH = 380) {
        const iconPath = path.join(this.dataDir, 'assets', `${this.appName.toLowerCase()}.ico`);

        return new Promise((resolve) => {
            const htmlTemplate = fs.readFileSync(path.join(__dirname, 'dialog.html'), 'utf8');
            const html = htmlTemplate.replace('__PLUGIN_DATA__', JSON.stringify(dialogData));

            let settled = false;
            const settle = (granted) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                server.close();
                resolve(granted);
            };

            const timeout = setTimeout(() => {
                console.warn(`[vm] permission dialog timed out for "${dialogData.name}" - denying`);
                settle(false);
            }, 2 * 60 * 1000);

            const server = http.createServer((req, res) => {
                // -- Favicon ----------------------------------------------------
                if (req.url === '/favicon.ico') {
                    try {
                        res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'no-cache' });
                        res.end(fs.readFileSync(iconPath));
                    } catch (_) { res.writeHead(204); res.end(); }
                    return;
                }

                // -- SSE endpoint - stays open while the dialog window is open --
                // When the window closes, this connection drops -> settle(false).
                if (req.method === 'GET' && req.url === '/sse') {
                    res.writeHead(200, {
                        'Content-Type' : 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection'   : 'keep-alive',
                    });
                    res.write('data: connected\n\n');

                    const hb = setInterval(() => {
                        try { res.write(':ping\n\n'); }
                        catch (_) { clearInterval(hb); }
                    }, 25000);

                    req.socket.once('close', () => {
                        clearInterval(hb);
                        // Small delay so any in-flight POST /result still wins
                        setTimeout(() => settle(false), 500);
                    });
                    return;
                }

                // -- Serve the dialog HTML --------------------------------------
                if (req.method === 'GET' && req.url === '/') {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(html);
                    return;
                }

                // -- Receive the Allow / Deny click -----------------------------
                if (req.method === 'POST' && req.url === '/result') {
                    let body = '';
                    req.on('data', chunk => { body += chunk; });
                    req.on('end', () => {
                        try {
                            const { granted } = JSON.parse(body);
                            res.writeHead(200); res.end();
                            settle(!!granted);
                        } catch (_) { res.writeHead(400); res.end(); }
                    });
                    return;
                }

                res.writeHead(404); res.end();
            });

            server.listen(0, '127.0.0.1', () => {
                const { port } = server.address();
                this._openBrowser(`http://127.0.0.1:${port}/`, winW, winH);
            });

            server.on('error', (err) => {
                console.error(`[vm] dialog server error: ${err.message}`);
                settle(false);
            });
        });
    }

    // -- Permission check for a single plugin (load saved or prompt) -----------

    async _checkPermissions(pluginId, meta, requested) {
        if (!requested || requested.length === 0) return new Set();

        // -- Feature-flag gate: check opt-in flags before prompting the user ---
        const flags = this._readFeatureFlags();

        // Block experimental plugins unless the experimental flag is enabled
        if (meta.experimental === true && !flags['features.experimental']) {
            throw new Error(
                `[vm] Plugin "${pluginId}" is marked experimental. ` +
                `Enable "features.experimental" in Settings to load it.`
            );
        }

        // Block broad (unscoped) sensitive permissions unless the flag is on.
        // Scoped variants like "system.exec:powershell" are allowed without a flag.
        for (const perm of requested) {
            const blocked = FEATURE_GATED_PERMS[perm]; // exact match = unscoped
            if (blocked && !flags[blocked]) {
                throw new Error(
                    `[vm] Plugin "${pluginId}" requests "${perm}" (unrestricted). ` +
                    `Enable "${blocked}" in Settings -> Feature Flags to allow it.`
                );
            }
        }

        const saved = this._loadSavedPerms(pluginId);
        if (saved !== null) return saved;

        const winH = Math.min(Math.max(206 + requested.length * 54, 290), 500);

        // Expand ${dataDir} and ${pluginDataDir} in reason keys so they match expanded perms
        const pluginDataDir = path.join(this.dataDir, 'plugins', pluginId);
        const expandedReasons = {};
        for (const [k, v] of Object.entries(meta.permissionReasons || {})) {
            expandedReasons[k
                .replace('${dataDir}', this.dataDir)
                .replace('${pluginDataDir}', pluginDataDir)] = v;
        }

        const dialogData = {
            type            : 'plugin',
            appName         : this.appName,
            name            : meta.name    || meta.id,
            version         : meta.version || '',
            description     : meta.description || '',
            permissions     : requested,
            permDescriptions: PERM_DESCRIPTIONS,
            permReasons     : expandedReasons,
            winW            : 420,
            winH,
        };

        const granted = await this._showPermDialog(dialogData, 420, winH);
        if (!granted) {
            throw new Error(`[vm] Permission denied by user for plugin "${pluginId}"`);
        }

        const perms = new Set(requested);
        this._savePerms(pluginId, perms);
        return perms;
    }

    // -- Bundle permission check (merged dialog for all members) ---------------

    async _checkBundlePermissions(bundleMeta, memberMetas) {
        const anyMissing = memberMetas.some(meta => {
            const requested = (meta.permissions || []).map(p =>
                p.replace('${dataDir}', this.dataDir)
            );
            return requested.length > 0 && this._loadSavedPerms(meta.id) === null;
        });

        if (!anyMissing) return true;

        const groups = memberMetas
            .map(meta => {
                const pluginDataDir = path.join(this.dataDir, 'plugins', meta.id);
                const expandedReasons = {};
                for (const [k, v] of Object.entries(meta.permissionReasons || {})) {
                    expandedReasons[k
                        .replace('${dataDir}', this.dataDir)
                        .replace('${pluginDataDir}', pluginDataDir)] = v;
                }
                return {
                    id          : meta.id,
                    name        : meta.name || meta.id,
                    description : meta.description || '',
                    permissions : (meta.permissions || []).map(p =>
                        p.replace('${dataDir}', this.dataDir)
                         .replace('${pluginDataDir}', pluginDataDir)
                    ),
                    permReasons : expandedReasons,
                };
            })
            .filter(g => g.permissions.length > 0);

        const totalPerms   = groups.reduce((n, g) => n + g.permissions.length, 0);
        const groupHeaders = groups.length;
        const winH = Math.min(Math.max(216 + totalPerms * 58 + groupHeaders * 26, 290), 520);

        const dialogData = {
            type            : 'bundle',
            appName         : this.appName,
            name            : bundleMeta.name    || bundleMeta.id,
            version         : bundleMeta.version || '',
            description     : bundleMeta.description || '',
            plugins         : groups,
            permDescriptions: PERM_DESCRIPTIONS,
            winW            : 440,
            winH,
        };

        const granted = await this._showPermDialog(dialogData, 440, winH);
        if (!granted) return false;

        for (const meta of memberMetas) {
            const requested = (meta.permissions || []).map(p =>
                p.replace('${dataDir}', this.dataDir)
            );
            this._savePerms(meta.id, new Set(requested));
        }
        return true;
    }

    // -- Load a bundle (show merged dialog, then load each member) -------------

    async _loadBundle(bundleMeta, allPluginManifests, cache) {
        const memberIds = bundleMeta.plugins || [];
        const memberMetas = [];

        for (const id of memberIds) {
            const meta = allPluginManifests[id];
            if (!meta) {
                console.warn(`[vm] bundle "${bundleMeta.id}" member "${id}" not found in plugins folder`);
                continue;
            }
            memberMetas.push(meta);
        }

        if (memberMetas.length === 0) {
            console.warn(`[vm] bundle "${bundleMeta.id}" has no loadable members`);
            return;
        }

        console.log(`[vm] loading bundle "${bundleMeta.id}" (${memberMetas.map(m => m.id).join(', ')})`);

        const granted = await this._checkBundlePermissions(bundleMeta, memberMetas);
        if (!granted) {
            for (const meta of memberMetas) {
                cache[meta.id] = { status: 'denied', folder: meta._folder };
            }
            throw new Error(`[vm] Bundle "${bundleMeta.id}" denied by user`);
        }

        for (const meta of memberMetas) {
            if (this._loaded.includes(meta.id)) continue;
            try {
                await this.loadPlugin(meta._dir);
                cache[meta.id] = { status: 'loaded', folder: meta._folder };
            } catch (e) {
                console.error(`[vm] bundle member "${meta.id}" failed: ${e.message}`);
                cache[meta.id] = { status: 'error', folder: meta._folder, error: e.message };
            }
        }
    }

    // -- Management API (exposed as the 'vm' service) --------------------------

    /**
     * Returns the full plugin/bundle list from disk, annotated with live status.
     */
    getAllPlugins() {
        const cache = this._loadCache();
        const result = [];

        if (!fs.existsSync(this.pluginsDir)) return result;

        const folders = fs.readdirSync(this.pluginsDir).filter(e => {
            try { return fs.statSync(path.join(this.pluginsDir, e)).isDirectory(); }
            catch (_) { return false; }
        });

        for (const folder of folders) {
            const dir        = path.join(this.pluginsDir, folder);
            const bundleFile = path.join(dir, 'bundle.json');
            const pluginFile = path.join(dir, 'plugin.json');

            if (fs.existsSync(bundleFile)) {
                try {
                    const meta  = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
                    const entry = cache[meta.id] || {};
                    result.push({
                        id: meta.id, name: meta.name || meta.id,
                        version: meta.version || '', description: meta.description || '',
                        type: 'bundle', members: meta.plugins || [],
                        dependencies: [], permissions: [], dependents: [],
                        status: entry.status || 'new',
                        loaded: this._loaded.includes(meta.id),
                    });
                } catch (_) {}
            } else if (fs.existsSync(pluginFile)) {
                try {
                    const meta  = JSON.parse(fs.readFileSync(pluginFile, 'utf8'));
                    const entry = cache[meta.id] || {};
                    result.push({
                        id: meta.id, name: meta.name || meta.id,
                        version: meta.version || '', description: meta.description || '',
                        type: 'plugin',
                        dependencies: Object.keys(meta.dependencies || {}),
                        permissions: meta.permissions || [], dependents: [],
                        status: entry.status || 'new',
                        loaded: this._loaded.includes(meta.id),
                    });
                } catch (_) {}
            }
        }

        // Fill in dependents: which other plugins list this one as a dependency
        for (const p of result) {
            p.dependents = result
                .filter(q => q.dependencies.includes(p.id))
                .map(q => q.id);
        }

        return result;
    }

    /**
     * Returns a deep list of all plugin IDs that (transitively) depend on `id`.
     */
    getAllDependents(id) {
        const plugins = this.getAllPlugins();
        const direct = (x) => plugins.filter(p => p.dependencies.includes(x)).map(p => p.id);
        const visited = new Set();
        const walk = (x) => {
            if (visited.has(x)) return;
            visited.add(x);
            for (const d of direct(x)) walk(d);
        };
        walk(id);
        visited.delete(id);
        return [...visited];
    }

    /**
     * Mark a plugin as disabled. Effect is permanent but only fully takes effect
     * on next restart (we can't unload running plugin code).
     */
    disablePlugin(id) {
        const cache = this._loadCache();
        cache[id] = { ...(cache[id] || {}), status: 'disabled' };
        this._saveCache(cache);
        return { ok: true, restart_required: this._loaded.includes(id) };
    }

    /**
     * Re-enable a disabled/denied/errored plugin and immediately try to load it.
     */
    async enablePlugin(id) {
        const cache = this._loadCache();
        const existing = cache[id] || {};
        cache[id] = { status: 'loaded', ...(existing.folder ? { folder: existing.folder } : {}) };
        this._saveCache(cache);
        if (!this._loaded.includes(id)) {
            await this._syncPlugins();
        }
        return { ok: true, loaded: this._loaded.includes(id) };
    }

    /**
     * Delete saved permissions and re-prompt on next load attempt.
     */
    async resetPluginPerms(id) {
        try { fs.unlinkSync(this._permsFile(id)); } catch (_) {}
        const cache = this._loadCache();
        const existing = cache[id] || {};
        // If it was loaded before, mark as 'loaded' but without saved perms it will re-prompt
        cache[id] = { status: 'loaded', ...(existing.folder ? { folder: existing.folder } : {}) };
        this._saveCache(cache);
        // Remove from _loaded so the sync will attempt to re-run it (and re-prompt)
        this._loaded = this._loaded.filter(x => x !== id);
        await this._syncPlugins();
        return { ok: true };
    }

    // -- Sandbox context builder -----------------------------------------------

    _buildCtx(pluginId, grantedPerms, pluginDir, meta) {
        const self = this;

        const scopeRoots = (base) => {
            const roots = [];
            for (const p of grantedPerms) {
                if (!p.startsWith(base + ':')) continue;
                const scope = p.slice(base.length + 1).replace('${dataDir}', self.dataDir);
                roots.push(path.resolve(scope));
            }
            if (grantedPerms.has(base)) roots.push(path.resolve(path.join(__dirname, '..')));
            return roots;
        };

        const assertPath = (base, filePath) => {
            // Unscoped permission (e.g. "fs.read" with no path) = unrestricted access
            if (grantedPerms.has(base)) return;
            const roots = scopeRoots(base);
            if (roots.length === 0) throw new Error(`Permission denied: ${base} not granted`);
            const resolved = path.resolve(filePath);
            const ok = roots.some(r => resolved === r || resolved.startsWith(r + path.sep));
            if (!ok) throw new Error(`Permission denied: ${base} access outside allowed paths`);
        };

        const has = (perm) => grantedPerms.has(perm) ||
            [...grantedPerms].some(p => p === perm || p.startsWith(perm + ':'));

        return {
            pluginId,
            pluginDir,
            dataDir    : path.join(self.dataDir, 'plugins', pluginId),
            appName    : self.appName,
            appVersion : self.appVersion,
            loadedPlugins: () => [...self._loaded],

            readFile(filePath) {
                assertPath('fs.read', filePath);
                return fs.readFileSync(filePath, 'utf8');
            },
            readFileBuffer(filePath) {
                assertPath('fs.read', filePath);
                return fs.readFileSync(filePath);
            },
            writeFile(filePath, data) {
                assertPath('fs.write', filePath);
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, data, 'utf8');
            },
            existsSync(filePath) {
                assertPath('fs.read', filePath);
                return fs.existsSync(filePath);
            },
            readDir(dirPath) {
                assertPath('fs.read', dirPath);
                return fs.readdirSync(dirPath);
            },

            listen(port, handler) {
                if (!has('net.listen')) throw new Error('Permission denied: net.listen not granted');
                const allowed = [...grantedPerms]
                    .filter(p => p.startsWith('net.listen:'))
                    .map(p => parseInt(p.split(':')[1], 10));
                if (allowed.length > 0 && !allowed.includes(port)) {
                    throw new Error(`Permission denied: net.listen on port ${port} not granted`);
                }
                const server = http.createServer(handler);
                server.listen(port);
                return server;
            },

            fetch(url, options) {
                if (!has('net.connect')) throw new Error('Permission denied: net.connect not granted');
                const allowed = [...grantedPerms]
                    .filter(p => p.startsWith('net.connect:'))
                    .map(p => p.split(':')[1]);
                if (allowed.length > 0) {
                    try {
                        const host = new URL(url).hostname;
                        if (!allowed.includes(host)) {
                            throw new Error(`Permission denied: net.connect to "${host}" not granted`);
                        }
                    } catch (e) {
                        if (e.message.startsWith('Permission denied')) throw e;
                    }
                }
                return global.fetch
                    ? global.fetch(url, options)
                    : Promise.reject(new Error('fetch not available - upgrade Node.js to v18+'));
            },

            exec(cmd, args = []) {
                if (!has('system.exec')) throw new Error('Permission denied: system.exec not granted');
                const allowed = [...grantedPerms]
                    .filter(p => p.startsWith('system.exec:'))
                    .map(p => p.split(':')[1]);
                const cmdBase = path.basename(cmd).replace(/\.exe$/i, '').toLowerCase();
                if (allowed.length > 0 && !allowed.includes(cmdBase)) {
                    throw new Error(`Permission denied: system.exec for "${cmdBase}" not granted`);
                }
                return execFileSync(cmd, args, { encoding: 'utf8' });
            },

            execAsync(cmd) {
                if (!has('system.exec')) throw new Error('Permission denied: system.exec not granted');
                const allowed = [...grantedPerms]
                    .filter(p => p.startsWith('system.exec:'))
                    .map(p => p.split(':')[1]);
                if (allowed.length > 0) {
                    const cmdBase = cmd.trim().split(/\s+/)[0].toLowerCase();
                    if (!allowed.includes(cmdBase)) {
                        throw new Error(`Permission denied: system.exec for "${cmdBase}" not granted`);
                    }
                }
                return new Promise((res, rej) =>
                    exec(cmd, (err, stdout) => err ? rej(err) : res(stdout))
                );
            },

            /**
             * Launch a detached background process (fire-and-forget).
             * Requires system.exec permission for the target command.
             */
            spawnDetached(cmd, args = [], opts = {}) {
                if (!has('system.exec')) throw new Error('Permission denied: system.exec not granted');
                const allowed = [...grantedPerms]
                    .filter(p => p.startsWith('system.exec:'))
                    .map(p => p.split(':')[1]);
                const cmdBase = path.basename(cmd).replace(/\.exe$/i, '').toLowerCase();
                if (allowed.length > 0 && !allowed.includes(cmdBase)) {
                    throw new Error(`Permission denied: system.exec for "${cmdBase}" not granted`);
                }
                const child = spawn(cmd, args, {
                    detached   : true,
                    stdio      : 'ignore',
                    windowsHide: true,
                    ...opts,
                });
                child.unref();
                return child.pid;
            },

            provide(name, value) {
                if (!has('ctx.provide')) throw new Error('Permission denied: ctx.provide not granted');
                self._services.set(name, value);
                self._serviceProviders.set(name, pluginId);
            },

            use(name) {
                // The built-in 'vm' service is gated by the vm.manage permission
                if (name === 'vm') {
                    if (!has('vm.manage')) {
                        throw new Error('Permission denied: vm.manage not granted - declare it in plugin.json to access VM control');
                    }
                } else {
                    // Access gate: caller must declare the providing plugin as a dependency
                    const providerId = self._serviceProviders.get(name);
                    if (providerId) {
                        const deps = Object.keys(meta.dependencies || {});
                        if (!deps.includes(providerId)) {
                            throw new Error(
                                `Plugin "${pluginId}" used service "${name}" (from "${providerId}") ` +
                                `without declaring "${providerId}" as a dependency in plugin.json`
                            );
                        }
                    }
                }
                if (!self._services.has(name)) {
                    throw new Error(`Service "${name}" not found - is the plugin that provides it loaded?`);
                }
                const service = self._services.get(name);
                // Function filtering: "uses": { "log": ["info", "warn"] } in plugin.json
                const allowed = (meta.uses || {})[name];
                if (Array.isArray(allowed) && allowed.length > 0 &&
                    typeof service === 'object' && service !== null) {
                    return Object.fromEntries(
                        allowed
                            .filter(fn => typeof service[fn] === 'function')
                            .map(fn => [fn, service[fn].bind(service)])
                    );
                }
                return service;
            },

            broadcast(msg) {
                if (!has('ctx.broadcast')) throw new Error('Permission denied: ctx.broadcast not granted');
                const events = self._services.get('events');
                if (events) events.emit('vm:broadcast', msg);
            },
            onMessage(_type, _handler) {},
            reply(_socket, _msg) {},
        };
    }

    // -- Run plugin code in a Node vm sandbox ----------------------------------

    _runPlugin(pluginDir, meta, ctx) {
        const mainFile = path.join(pluginDir, meta.main || 'index.js');
        const code = fs.readFileSync(mainFile, 'utf8');

        const ALLOWED_BUILTINS = new Set([
            'path', 'events', 'util', 'url', 'querystring',
            'stream', 'crypto', 'buffer', 'string_decoder',
        ]);

        const moduleObj = { exports: {} };
        const sandbox = vm.createContext({
            module     : moduleObj,
            exports    : moduleObj.exports,
            __dirname  : pluginDir,
            __filename : mainFile,
            console,
            Buffer,
            setTimeout, clearTimeout, setInterval, clearInterval,
            Promise,
            require(id) {
                if (ALLOWED_BUILTINS.has(id)) return require(id);
                throw new Error(
                    `[vm] Plugin "${meta.id}" tried to require("${id}") - ` +
                    `use the ctx API instead or request the appropriate permission.`
                );
            },
        });

        vm.runInContext(code, sandbox, { filename: mainFile });

        const plugin = sandbox.module.exports;
        if (typeof plugin.install !== 'function') {
            throw new Error(`[vm] Plugin "${meta.id}" does not export an install() function`);
        }
        plugin.install(ctx);
    }

    // -- loadPlugin (single plugin, no cache management) ----------------------

    async loadPlugin(pluginDir) {
        const metaPath = path.join(pluginDir, 'plugin.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        const pluginDataDir = path.join(this.dataDir, 'plugins', meta.id);
        const requested = (meta.permissions || []).map(p =>
            p.replace('${dataDir}', this.dataDir)
             .replace('${pluginDataDir}', pluginDataDir)
        );

        console.log(`[vm] loading "${meta.id}" (${meta.name || meta.id})`);

        const grantedPerms = await this._checkPermissions(meta.id, meta, requested);
        const ctx = this._buildCtx(meta.id, grantedPerms, pluginDir, meta);

        fs.mkdirSync(ctx.dataDir, { recursive: true });
        this._runPlugin(pluginDir, meta, ctx);

        this._loaded.push(meta.id);
        this._pluginMetas.set(meta.id, meta);   // track for dependency graph
        console.log(`[vm] "${meta.id}" loaded`);
    }

    // -- _syncPlugins: scan folder, update cache, load new plugins/bundles -----

    async _syncPlugins() {
        if (this._syncing) return;
        this._syncing = true;
        try { await this.__doSync(); }
        finally { this._syncing = false; }
    }

    async __doSync() {
        const cache = this._loadCache();

        if (!fs.existsSync(this.pluginsDir)) {
            console.warn(`[vm] plugins directory not found: ${this.pluginsDir}`);
            return;
        }

        // -- Snapshot current folders ------------------------------------------
        const presentFolders = new Set(
            fs.readdirSync(this.pluginsDir).filter(e => {
                try { return fs.statSync(path.join(this.pluginsDir, e)).isDirectory(); }
                catch (_) { return false; }
            })
        );

        // -- Mark removed items ------------------------------------------------
        for (const [id, entry] of Object.entries(cache)) {
            if (entry.status !== 'removed' && entry.folder && !presentFolders.has(entry.folder)) {
                console.log(`[vm] "${id}" folder removed - will re-try if added back`);
                cache[id] = { ...entry, status: 'removed' };
            }
        }

        // -- Separate bundles from plugins -------------------------------------
        const bundleManifests = {};
        const pluginManifests = {};

        for (const folder of presentFolders) {
            const dir        = path.join(this.pluginsDir, folder);
            const bundleFile = path.join(dir, 'bundle.json');
            const pluginFile = path.join(dir, 'plugin.json');

            if (fs.existsSync(bundleFile)) {
                try {
                    const meta   = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
                    meta._dir    = dir;
                    meta._folder = folder;
                    bundleManifests[meta.id] = meta;
                } catch (e) { console.error(`[vm] skipping bundle "${folder}": ${e.message}`); }
            } else if (fs.existsSync(pluginFile)) {
                try {
                    const meta   = JSON.parse(fs.readFileSync(pluginFile, 'utf8'));
                    meta._dir    = dir;
                    meta._folder = folder;
                    pluginManifests[meta.id] = meta;
                } catch (e) { console.error(`[vm] skipping plugin "${folder}": ${e.message}`); }
            }
        }

        // shouldLoad: returns true if this id should be loaded in this sync pass
        const shouldLoad = (id) => {
            if (this._loaded.includes(id)) return false;
            const entry = cache[id];
            if (!entry) return true;
            if (entry.status === 'removed')  return true;
            if (entry.status === 'loaded')   return true;   // new session
            if (entry.status === 'disabled') return false;  // explicitly disabled
            return false;                                   // denied / error - wait for drag cycle
        };

        // -- Load bundles first ------------------------------------------------
        for (const bundleId of Object.keys(bundleManifests)) {
            if (!shouldLoad(bundleId)) continue;
            const bundleMeta = bundleManifests[bundleId];
            try {
                await this._loadBundle(bundleMeta, pluginManifests, cache);
                this._loaded.push(bundleId);
                cache[bundleId] = { status: 'loaded', folder: bundleMeta._folder, type: 'bundle' };
            } catch (e) {
                const denied = e.message.includes('denied by user');
                console.log(`[vm] bundle "${bundleId}" ${denied ? 'denied by user' : 'failed: ' + e.message}`);
                cache[bundleId] = {
                    status: denied ? 'denied' : 'error',
                    folder: bundleMeta._folder, type: 'bundle',
                    ...(denied ? {} : { error: e.message }),
                };
            }
        }

        // -- Topological async load of standalone plugins ----------------------
        const visited = new Set();
        const load = async (id) => {
            if (visited.has(id)) return;
            visited.add(id);
            if (!shouldLoad(id)) return;

            const meta = pluginManifests[id];
            if (!meta) {
                console.warn(`[vm] dependency "${id}" not found in plugins folder`);
                return;
            }

            for (const dep of Object.keys(meta.dependencies || {})) await load(dep);

            try {
                await this.loadPlugin(meta._dir);
                cache[id] = { status: 'loaded', folder: meta._folder };
            } catch (e) {
                const denied = e.message.includes('Permission denied by user');
                console.log(`[vm] "${id}" ${denied ? 'denied by user' : 'failed: ' + e.message}`);
                cache[id] = { status: denied ? 'denied' : 'error', folder: meta._folder,
                    ...(denied ? {} : { error: e.message }) };
            }
        };

        for (const id of Object.keys(pluginManifests)) await load(id);

        this._saveCache(cache);
    }

    // -- Folder watcher --------------------------------------------------------

    watchPlugins() {
        if (!fs.existsSync(this.pluginsDir)) return;

        let debounce = null;
        fs.watch(this.pluginsDir, { persistent: true }, () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                this._syncPlugins().catch(e =>
                    console.error('[vm] watch sync error:', e.message)
                );
            }, 600);
        });

        console.log(`[vm] watching ${this.pluginsDir}`);
    }

    // -- Public API ------------------------------------------------------------

    async loadAll() {
        // Register the built-in VM control service before plugins load,
        // so plugins declared with vm.manage permission can use it immediately.
        this._serviceProviders.set('vm', '__builtin__');
        this._services.set('vm', {
            getAll         : ()     => this.getAllPlugins(),
            getDependents  : (id)   => this.getAllDependents(id),
            disable        : (id)   => this.disablePlugin(id),
            enable         : (id)   => this.enablePlugin(id),
            resetPerms     : (id)   => this.resetPluginPerms(id),
            getLoaded      : ()     => [...this._loaded],
        });

        await this._syncPlugins();
        this.watchPlugins();
    }
}

module.exports = { PluginVM };
