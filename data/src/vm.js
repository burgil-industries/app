'use strict';
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const { exec, spawn } = require('child_process');

// -- Permission metadata -------------------------------------------------------
const PERM_DESCRIPTIONS = {
    'fs.read'        : 'Read files from your computer',
    'fs.write'       : 'Write files to your computer',
    'net.listen'     : 'Start a local server on your machine',
    'net.connect'    : 'Connect to the internet',
    'system.exec'    : 'Run system commands',
    'ctx.provide'    : 'Provide services to other plugins',
    'ctx.broadcast'  : 'Send messages to all connected clients',
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
        this.pluginsDir  = options.pluginsDir;
        this.dataDir     = options.dataDir;
        this.appName     = options.appName    || 'Computer';
        this.appVersion  = options.appVersion || '1.0.0';
        this._services   = new Map();   // name -> value (provided by plugins)
        this._loaded     = [];          // plugin/bundle IDs loaded in this session
        this._syncing    = false;       // mutex: prevents concurrent _syncPlugins calls
    }

    // -- Plugin cache (data/plugins-cache.json) --------------------------------
    // Tracks per-plugin/bundle status across restarts so denied/broken items
    // aren't re-prompted on every launch - only after a drag-out + drag-back.
    //
    // Schema: { [id]: { status: "loaded"|"denied"|"error"|"removed", folder?: string, type?: "bundle" } }

    _cacheFile() {
        return path.join(this.dataDir, 'plugins-cache.json');
    }

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
            spawn(edge, [
                `--app=${url}`,
                `--window-size=${w},${h}`,
                '--no-first-run',
                '--disable-extensions',
                '--disable-default-apps',
            ], { detached: true, stdio: 'ignore' }).unref();
        } else {
            exec(`cmd /c start "" "${url}"`);
        }
    }

    /**
     * Show the permission dialog in Edge and resolve when the user responds
     * or closes the window.
     *
     * @param {object} dialogData  - Fully-formed data object injected into dialog.html
     * @param {number} [winW=420]
     * @param {number} [winH=380]
     * @returns {Promise<boolean>} true = granted, false = denied/closed
     */
    _showPermDialog(dialogData, winW = 420, winH = 380) {
        // App icon served as /favicon.ico
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

            // Auto-deny if the user never responds (e.g. killed the process)
            const timeout = setTimeout(() => {
                console.warn(`[vm] permission dialog timed out for "${dialogData.name}" - denying`);
                settle(false);
            }, 2 * 60 * 1000);

            const server = http.createServer((req, res) => {
                // ── Favicon ────────────────────────────────────────────────────
                if (req.url === '/favicon.ico') {
                    try {
                        res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'no-cache' });
                        res.end(fs.readFileSync(iconPath));
                    } catch (_) {
                        res.writeHead(204); res.end();
                    }
                    return;
                }

                // ── Serve the dialog HTML ──────────────────────────────────────
                if (req.method === 'GET' && req.url === '/') {
                    // Detect window close: if the socket drops before a POST /result
                    // arrives, treat it as Deny (with a small delay so a POST that
                    // arrives on the same keep-alive connection still wins).
                    req.socket.once('close', () => {
                        setTimeout(() => settle(false), 300);
                    });

                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Connection'  : 'keep-alive',
                    });
                    res.end(html);
                    return;
                }

                // ── Receive the Allow / Deny click ─────────────────────────────
                if (req.method === 'POST' && req.url === '/result') {
                    let body = '';
                    req.on('data', chunk => { body += chunk; });
                    req.on('end', () => {
                        try {
                            const { granted } = JSON.parse(body);
                            res.writeHead(200);
                            res.end();
                            settle(!!granted);
                        } catch (_) {
                            res.writeHead(400);
                            res.end();
                        }
                    });
                    return;
                }

                res.writeHead(404);
                res.end();
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

        const saved = this._loadSavedPerms(pluginId);
        if (saved !== null) return saved;   // already decided

        // Height: header(90) + section(28) + items(54 each) + footer(52) + chrome(36)
        const winH = Math.min(Math.max(206 + requested.length * 54, 290), 500);

        const dialogData = {
            type            : 'plugin',
            appName         : this.appName,
            name            : meta.name    || meta.id,
            version         : meta.version || '',
            description     : meta.description || '',
            permissions     : requested,
            permDescriptions: PERM_DESCRIPTIONS,
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
        // Only show the dialog if at least one member is missing saved perms
        const anyMissing = memberMetas.some(meta => {
            const requested = (meta.permissions || []).map(p =>
                p.replace('${dataDir}', this.dataDir)
            );
            return requested.length > 0 && this._loadSavedPerms(meta.id) === null;
        });

        if (!anyMissing) return true;   // all already decided - silent load

        // Build groups for the dialog
        const groups = memberMetas
            .map(meta => ({
                id          : meta.id,
                name        : meta.name || meta.id,
                permissions : (meta.permissions || []).map(p =>
                    p.replace('${dataDir}', this.dataDir)
                ),
            }))
            .filter(g => g.permissions.length > 0);

        const totalPerms   = groups.reduce((n, g) => n + g.permissions.length, 0);
        const groupHeaders = groups.length;
        const winH = Math.min(Math.max(206 + totalPerms * 54 + groupHeaders * 26, 290), 520);

        const dialogData = {
            type            : 'bundle',
            appName         : this.appName,
            name            : bundleMeta.name    || bundleMeta.id,
            version         : bundleMeta.version || '',
            description     : bundleMeta.description || '',
            plugins         : groups,
            permDescriptions: PERM_DESCRIPTIONS,
        };

        const granted = await this._showPermDialog(dialogData, 440, winH);
        if (!granted) return false;

        // Save permissions for every member
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
            // Mark each member denied in cache too
            for (const meta of memberMetas) {
                cache[meta.id] = { status: 'denied', folder: meta._folder };
            }
            throw new Error(`[vm] Bundle "${bundleMeta.id}" denied by user`);
        }

        // Load each member in declaration order (respecting already-loaded deps)
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

    // -- Sandbox context builder -----------------------------------------------

    _buildCtx(pluginId, grantedPerms, pluginDir) {
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
                return global.fetch ? global.fetch(url, options)
                    : Promise.reject(new Error('fetch not available in this Node version'));
            },

            exec(cmd, args = []) {
                if (!has('system.exec')) throw new Error('Permission denied: system.exec not granted');
                const allowed = [...grantedPerms]
                    .filter(p => p.startsWith('system.exec:'))
                    .map(p => p.split(':')[1]);
                const cmdBase = cmd.trim().split(/\s+/)[0].toLowerCase();
                if (allowed.length > 0 && !allowed.includes(cmdBase)) {
                    throw new Error(`Permission denied: system.exec for "${cmdBase}" not granted`);
                }
                const { execFileSync } = require('child_process');
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

            provide(name, value) {
                if (!has('ctx.provide')) throw new Error('Permission denied: ctx.provide not granted');
                self._services.set(name, value);
            },
            use(name) {
                if (!self._services.has(name)) {
                    throw new Error(`Service "${name}" not found - is the plugin that provides it loaded?`);
                }
                return self._services.get(name);
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

        const requested = (meta.permissions || []).map(p =>
            p.replace('${dataDir}', this.dataDir)
        );

        console.log(`[vm] loading "${meta.id}" (${meta.name || meta.id})`);

        const grantedPerms = await this._checkPermissions(meta.id, meta, requested);
        const ctx = this._buildCtx(meta.id, grantedPerms, pluginDir);

        fs.mkdirSync(ctx.dataDir, { recursive: true });
        this._runPlugin(pluginDir, meta, ctx);
        this._loaded.push(meta.id);
        console.log(`[vm] "${meta.id}" loaded`);
    }

    // -- _syncPlugins: scan folder, update cache, load new plugins/bundles -----
    //
    // Cache status meanings:
    //   "loaded"  - successfully loaded (this session or a prior one)
    //   "denied"  - user closed the dialog or clicked Deny
    //   "error"   - plugin/bundle threw during load
    //   "removed" - folder was deleted; cleared when folder comes back
    //
    // A "denied" or "error" item is NOT retried until it has been removed
    // (status → "removed") and then re-added, forcing a fresh attempt.

    async _syncPlugins() {
        if (this._syncing) return;
        this._syncing = true;
        try {
            await this.__doSync();
        } finally {
            this._syncing = false;
        }
    }

    async __doSync() {
        const cache = this._loadCache();

        if (!fs.existsSync(this.pluginsDir)) {
            console.warn(`[vm] plugins directory not found: ${this.pluginsDir}`);
            return;
        }

        // ── Snapshot current folders ──────────────────────────────────────────
        const presentFolders = new Set(
            fs.readdirSync(this.pluginsDir).filter(e =>
                fs.statSync(path.join(this.pluginsDir, e)).isDirectory()
            )
        );

        // ── Mark removed items ────────────────────────────────────────────────
        for (const [id, entry] of Object.entries(cache)) {
            if (entry.status !== 'removed' && entry.folder && !presentFolders.has(entry.folder)) {
                console.log(`[vm] "${id}" folder removed - will re-try if added back`);
                cache[id] = { ...entry, status: 'removed' };
            }
        }

        // ── Separate bundles from plugins ─────────────────────────────────────
        const bundleManifests = {};   // bundleId -> meta
        const pluginManifests = {};   // pluginId -> meta

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
                } catch (e) {
                    console.error(`[vm] skipping bundle "${folder}": ${e.message}`);
                }
            } else if (fs.existsSync(pluginFile)) {
                try {
                    const meta   = JSON.parse(fs.readFileSync(pluginFile, 'utf8'));
                    meta._dir    = dir;
                    meta._folder = folder;
                    pluginManifests[meta.id] = meta;
                } catch (e) {
                    console.error(`[vm] skipping plugin "${folder}": ${e.message}`);
                }
            }
        }

        // ── Decide whether to (re-)load each item ─────────────────────────────
        const shouldLoad = (id) => {
            if (this._loaded.includes(id)) return false;   // already up this session
            const entry = cache[id];
            if (!entry) return true;                        // first time ever seen
            if (entry.status === 'removed') return true;   // came back after removal
            if (entry.status === 'loaded')  return true;   // new session, was working
            return false;                                   // denied/error - wait for drag cycle
        };

        // ── Load bundles first ────────────────────────────────────────────────
        for (const bundleId of Object.keys(bundleManifests)) {
            if (!shouldLoad(bundleId)) continue;
            const bundleMeta = bundleManifests[bundleId];
            try {
                await this._loadBundle(bundleMeta, pluginManifests, cache);
                this._loaded.push(bundleId);
                cache[bundleId] = { status: 'loaded', folder: bundleMeta._folder, type: 'bundle' };
            } catch (e) {
                const denied = e.message.includes('denied by user');
                const status = denied ? 'denied' : 'error';
                console.log(`[vm] bundle "${bundleId}" ${denied ? 'denied by user' : 'failed: ' + e.message}`);
                cache[bundleId] = { status, folder: bundleMeta._folder, type: 'bundle',
                    ...(denied ? {} : { error: e.message }) };
            }
        }

        // ── Topological async load of standalone plugins ──────────────────────
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
                const status = denied ? 'denied' : 'error';
                console.log(`[vm] "${id}" ${denied ? 'denied by user' : 'failed: ' + e.message}`);
                cache[id] = { status, folder: meta._folder, ...(denied ? {} : { error: e.message }) };
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
        await this._syncPlugins();
        this.watchPlugins();
    }
}

module.exports = { PluginVM };
