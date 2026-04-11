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
http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); })
    .listen(53420, '127.0.0.1', () => console.log('[app] heartbeat on 127.0.0.1:53420'))
    .on('error', err => {
        if (err.code === 'EADDRINUSE') {
            console.warn('[app] port 53420 already in use - another instance may be running');
        }
    });

vm.loadAll().catch(err => {
    console.error('[app] fatal:', err.message);
    console.error(err);
    process.exit(1);
});
