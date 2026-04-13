// Copyright (c) 2026 COMPUTER. Provided "AS IS" without warranty. See LICENSE for full terms.
'use strict';
const path = require('path');
const http = require('http');
const { PluginVM } = require('./vm');

// __dirname = <install_dir>/data/src/
// go up twice to reach the install root: data/src -> data -> install root
const installDir = path.join(__dirname, '..', '..');

const vm = new PluginVM({
    pluginsDir : path.join(installDir, 'plugins'),
    dataDir    : path.join(installDir, 'data'),
    appName    : 'Computer',
    appVersion : '1.0.0',
});

// Heartbeat server on port 53420 - lets the installer/updater detect that
// the app is running via Test-ComputerRunning (checks TCP listeners on 53420).
// Also accepts POST /hook to trigger hooks from external entry points
// (open.ps1, router.ps1, launcher, protocol handler, etc.).
http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/hook') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { hook, data } = JSON.parse(body);
                if (!hook || typeof hook !== 'string') {
                    res.writeHead(400); res.end('{"error":"missing hook"}');
                    return;
                }
                console.log(`[app] hook received: ${hook}`);

                const hooks = vm.getService('hooks');
                if (hooks) {
                    await hooks.doAction(hook, data || {});
                }

                // Built-in file-open handler: runs even without hooks/plugins
                if (hook === 'app:file-open' && data && data.path &&
                    data.path.endsWith('.computer')) {
                    console.log(`[app] handling file-open: ${data.path}`);
                    try { await vm.handleFileOpen(data.path); }
                    catch (e) { console.error(`[app] handleFileOpen error: ${e.message}`); }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            } catch (e) {
                console.error(`[app] hook error: ${e.message}`);
                res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    res.writeHead(200); res.end('ok');
}).listen(53420, '127.0.0.1', () => console.log('[app] heartbeat on 127.0.0.1:53420'))
  .on('error', err => {
      if (err.code === 'EADDRINUSE') {
          console.warn('[app] port 53420 already in use - another instance may be running');
      }
  });

vm.loadAll().then(async () => {
    const hooks = vm.getService('hooks');
    if (hooks) {
        await hooks.doAction('app:launch', {});
    }
    console.log('[app] ready');
}).catch(err => {
    console.error('[app] fatal:', err.message);
    console.error(err);
    process.exit(1);
});

// Fire app:shutdown on clean exit
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
        const hooks = vm.getService('hooks');
        if (hooks) await hooks.doAction('app:shutdown', {});
        process.exit(0);
    });
}
