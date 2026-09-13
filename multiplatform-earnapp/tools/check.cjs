'use strict';
process.env.WS_NO_ZCOUNTER='1';
const assert = require('node:assert/strict');
const client = require('../sdk/client.js');
for (const name of ['pre_init','init','start','uninit','get_status','update_consent'])
    assert.equal(typeof client[name],'function',`Missing SDK API: ${name}`);
const m = require('../sdk/_modules.js');
for (const name of ['is_ipv6_target_allowed','ip_in_cidrs','calc_cpu_usage'])
    assert.equal(typeof m.tunnel_util[name],'function',`Missing tunnel helper: ${name}`);
assert.equal(typeof require('../sdk/util/task.js').Task,'function');
assert.ok(Array.isArray(require('../sdk/sdk_conf.js').lum_blocked_ips));
assert.equal(require('../sdk/package.json').version,require('../sdk/zon_config.json').ZON_VERSION);
assert.equal(require('../sdk/sdk_conf.js').conf.ZON_VERSION,require('../sdk/zon_config.json').ZON_VERSION);
console.log('PASS: editable client, configuration, SDK helpers and npm dependencies load.');
// Loading SDK helpers installs background handles on some runtimes.
process.exit(0);
