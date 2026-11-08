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
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
    extensionTestsEnv: { CLAUDE_REVIEW_HOME: dataHome, CRC_TEST_WORKSPACE: workspace },
  });
}

main().catch((err) => {
  console.error('Failed to run tests', err);
  process.exit(1);
});
