// Build script. Produces readable (unminified) bundles with sourcemaps so that
// reviewers can audit exactly what ships. No runtime dependencies are bundled
// besides Node built-ins and the `vscode` API (provided by the host).
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  legalComments: 'inline',
  logLevel: 'info',
};

function listTs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listTs(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []
  );
}

if (tests) {
  await esbuild.build({
    ...common,
    entryPoints: [...listTs('test/unit'), ...listTs('test/integration')],
    outdir: 'out/test',
    outbase: 'test',
    external: ['vscode', 'mocha', '@vscode/test-electron'],
    logLevel: 'warning',
  });
} else {
  const ext = { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] };
  const relay = { ...common, entryPoints: ['relay/main.ts'], outfile: 'dist/relay.js', sourcemap: false };
  if (watch) {
    const c1 = await esbuild.context(ext);
    const c2 = await esbuild.context(relay);
    await Promise.all([c1.watch(), c2.watch()]);
  } else {
    await esbuild.build(ext);
    await esbuild.build(relay);
    // The Claude Code plugin ships its own copy of the relay.
    mkdirSync('claude-plugin', { recursive: true });
    copyFileSync('dist/relay.js', 'claude-plugin/relay.js');
  }
}
