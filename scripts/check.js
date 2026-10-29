'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failures = 0;
let checked = 0;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) {
      checked++;
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) { failures++; process.stderr.write(result.stderr); }
    }
  }
}
for (const dir of ['src', 'scripts', 'userscript', 'tests']) walk(path.join(root, dir));
console.log(`Syntax checked ${checked} JavaScript files; failures: ${failures}`);
process.exitCode = failures ? 1 : 0;
