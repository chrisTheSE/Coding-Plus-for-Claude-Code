import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // When run from inside VS Code's own terminal/extension host this leaks in
  // and would make the test instance start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.js');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-ws-'));
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-data-'));
  // VS Code creates a Unix socket inside its user-data dir; macOS limits socket paths to
  // ~104 characters, which the default ".vscode-test/user-data" path exceeds on CI runners.
  const userData = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'crc-ud-'));
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, `--user-data-dir=${userData}`, '--disable-extensions', '--disable-workspace-trust'],
    extensionTestsEnv: { CLAUDE_REVIEW_HOME: dataHome, CRC_TEST_WORKSPACE: workspace },
  });
}

main().catch((err) => {
  console.error('Failed to run tests', err);
  process.exit(1);
});
