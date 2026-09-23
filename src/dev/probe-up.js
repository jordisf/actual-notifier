'use strict';
// Dev probe: PID1 uptime in a slim container (no ps).
// Parse /proc/<pid>/stat robustly: everything after the LAST ")" is the
// field stream starting at field 3 (state). starttime = field 22 (1-indexed)
// = index 19 within the post-paren stream.
const fs = require('fs');
const raw = fs.readFileSync('/proc/1/stat', 'utf8');
const post = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
const startTicks = Number(post[19]);
const up = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
const hz = process.gethrtime ? 100 : 100; // USER_HZ on Linux slim is 100
console.log('pid=' + raw.slice(0, raw.indexOf(' ')) + ' raw_start=' + raw.slice(0, 40));
console.log('start_ticks=' + startTicks + ' up_sec=' + up.toFixed(1));
console.log('pid1_uptime_sec=' + Math.round(up - startTicks / hz));
const code = fs.readFileSync('/app/src/listener.js', 'utf8');
console.log('disk_has_reload=' + code.includes('reloadTelegramEnv'));
