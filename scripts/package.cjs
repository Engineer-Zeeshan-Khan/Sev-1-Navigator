const { readdir, rm } = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function cleanRelease() {
  const releaseDir = path.join(root, 'release');
  const entries = await readdir(releaseDir, { withFileTypes: true });

  await Promise.all(entries.map(async (entry) => {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.pkg')) return;
    await rm(path.join(releaseDir, entry.name), { recursive: true, force: true });
  }));
}

async function main() {
  run(npm, ['run', 'build']);
  run(npm, ['exec', '--', 'electron-builder', ...process.argv.slice(2)], {
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  await cleanRelease();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
