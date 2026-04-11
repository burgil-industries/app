'use strict';
const path = require('path');
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

vm.loadAll().catch(err => {
    console.error('[app] fatal:', err.message);
    console.error(err);
    process.exit(1);
});
