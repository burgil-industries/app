'use strict';

// ── Permission Taxonomy ──────────────────────────────────────────────────────
//
// Format: category.action           (wildcard - grants all scopes)
//         category.action:scope     (scoped - grants only matching scope)
//
// Categories:
//   fs.read            Read any file
//   fs.read:<path>     Read files under a specific path
//   fs.write           Write any file
//   fs.write:<path>    Write files under a specific path
//   net.listen         Listen on any port
//   net.listen:<port>  Listen on a specific port
//   net.connect        Make outbound connections to any host
//   net.connect:<host> Connect to a specific host
//   system.exec        Execute any child process
//   system.exec:<cmd>  Execute a specific command
//   ctx.provide        Register services for other plugins
//   ctx.broadcast      Broadcast messages to all WS clients

const PERMISSION_CATEGORIES = [
    'fs.read',
    'fs.write',
    'net.listen',
    'net.connect',
    'system.exec',
    'ctx.provide',
    'ctx.broadcast',
];

const PERMISSION_DESCRIPTIONS = {
    'fs.read':        'Read files from your computer',
    'fs.write':       'Write files to your computer',
    'net.listen':     'Start a local server',
    'net.connect':    'Connect to the internet',
    'system.exec':    'Run system commands',
    'ctx.provide':    'Provide services to other plugins',
    'ctx.broadcast':  'Send messages to all connected clients',
};

class PermissionError extends Error {
    constructor(pluginId, needed) {
        super(`Plugin "${pluginId}" requires permission "${needed}" but was not granted it.`);
        this.name = 'PermissionError';
        this.pluginId = pluginId;
        this.permission = needed;
    }
}

/**
 * Parse a permission string into its components.
 * "fs.read:/some/path" -> { base: "fs.read", scope: "/some/path" }
 * "ctx.provide"        -> { base: "ctx.provide", scope: null }
 */
function parsePermission(str) {
    const colonIdx = str.indexOf(':');
    // Check if colon is after the category.action part (not within it)
    // e.g. "fs.read" has no colon, "fs.read:/path" has colon as scope separator
    // but "ctx.provide" should not split on any colon
    const parts = str.split(':');
    const base = parts[0];
    const scope = parts.length > 1 ? parts.slice(1).join(':') : null;
    return { base, scope };
}

/**
 * Check if a specific permission is granted by the granted list.
 * Supports wildcard: "fs.read" (no scope) grants "fs.read:/any/path".
 * Supports path matching: "fs.write:/data" grants "fs.write:/data/config.json".
 */
function checkPermission(grantedList, needed) {
    const { base: neededBase, scope: neededScope } = parsePermission(needed);

    for (const granted of grantedList) {
        const { base: grantedBase, scope: grantedScope } = parsePermission(granted);

        if (grantedBase !== neededBase) continue;

        // Wildcard: granted has no scope -> grants everything under this category
        if (grantedScope === null) return true;

        // Exact match
        if (neededScope === null) continue; // needed is wildcard but granted is scoped -> no match
        if (neededScope === grantedScope) return true;

        // Path prefix match: granted "/data" matches needed "/data/config.json"
        if (neededScope.startsWith(grantedScope + '/')) return true;
        if (neededScope.startsWith(grantedScope + '\\')) return true;
    }

    return false;
}

/**
 * Validate that all permissions in a list are recognized categories.
 * Returns array of unrecognized permissions (empty if all valid).
 */
function validatePermissions(permissions) {
    const invalid = [];
    for (const perm of permissions) {
        const { base } = parsePermission(perm);
        if (!PERMISSION_CATEGORIES.includes(base)) {
            invalid.push(perm);
        }
    }
    return invalid;
}

/**
 * Expand ${dataDir} tokens in permission scopes.
 */
function expandPermissions(permissions, dataDir) {
    return permissions.map(p => p.replace(/\$\{dataDir\}/g, dataDir));
}

module.exports = {
    PERMISSION_CATEGORIES,
    PERMISSION_DESCRIPTIONS,
    PermissionError,
    parsePermission,
    checkPermission,
    validatePermissions,
    expandPermissions,
};
