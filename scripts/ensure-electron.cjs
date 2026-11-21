const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const electronDirectory = path.dirname(require.resolve('electron'));
const pathFile = path.join(electronDirectory, 'path.txt');

function hasElectronRuntime() {
  try {
    const executable = fs.readFileSync(pathFile, 'utf8').trim();
    return executable.length > 0 && fs.existsSync(path.join(electronDirectory, 'dist', executable));
  } catch {
    return false;
  }
}

if (!hasElectronRuntime()) {
  console.log('Electron runtime is missing. Downloading it now...');
  const install = spawnSync(process.execPath, [path.join(electronDirectory, 'install.js')], {
    stdio: 'inherit',
  });

  if (install.error) {
    console.error(`Could not start the Electron installer: ${install.error.message}`);
    process.exit(1);
  }

  if (install.status !== 0 || !hasElectronRuntime()) {
    console.error(
      'Electron runtime installation failed. Check your network connection and npm install-script settings, then run `npm rebuild electron` and retry `npm run dev`.',
    );
    process.exit(install.status ?? 1);
  }
}
