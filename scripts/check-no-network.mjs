// Fails the build if the shipped bundles can open network connections or
// spawn processes unsafely. Run in CI on every change (npm run check:no-network).
import { readFileSync } from 'node:fs';

const NETWORK_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'inspector', 'worker_threads'];
const rules = [
  { re: new RegExp(`require\(["'](node:)?(${NETWORK_MODULES.join('|')})["']\)`, 'g'), why: 'network-capable Node module' },
  { re: /\bfetch\s*\(/g, why: 'fetch()' },
  { re: /\bWebSocket\b/g, why: 'WebSocket' },
  { re: /XMLHttpRequest/g, why: 'XMLHttpRequest' },
  { re: /\bimport\s*\(/g, why: 'dynamic import()' },
  { re: /\beval\s*\(/g, why: 'eval()' },
  { re: /new\s+Function\s*\(/g, why: 'new Function()' },
  { re: /shell\s*:\s*true/g, why: 'child_process with shell: true' },
  { re: /\bexecSync\s*\(|[^.\w]exec\s*\(/g, why: 'child_process.exec (use execFile)' },
  { re: /vscode\.env\.openExternal|openExternal\s*\(/g, why: 'opening external URLs' },
];
const extraForRelay = [{ re: /require\(["'](node:)?child_process["']\)/g, why: 'relay must not spawn processes' }];

let failed = false;
for (const [file, extra] of [['dist/extension.js', []], ['dist/relay.js', extraForRelay]]) {
  const src = readFileSync(file, 'utf8');
  for (const { re, why } of [...rules, ...extra]) {
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index).split('\n').length;
      console.error(`${file}:${line}: forbidden ${why}: ${m[0]}`);
      failed = true;
    }
  }
}
if (failed) {
  console.error('\nno-network check FAILED');
  process.exit(1);
}
console.log('no-network check passed: dist/extension.js and dist/relay.js contain no network, eval or shell-spawn code');
