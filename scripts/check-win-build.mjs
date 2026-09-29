/**
 * Guards the Windows installer build. Hotspot and Bluetooth sharing need
 * koffi's Windows binary (@koromix/koffi-win32-x64), which npm only installs
 * on Windows. Building the installer elsewhere used to silently produce an
 * installer where those two features fail.
 *
 *   node scripts/check-win-build.mjs          before electron-builder: fetch the binary if missing
 *   node scripts/check-win-build.mjs --after  after: confirm it's inside the packaged app
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PKG = '@koromix/koffi-win32-x64';
const dir = join('node_modules', PKG);
const hasBinary = (d) => existsSync(d) && readdirSync(d, { recursive: true }).some((f) => String(f).endsWith('.node'));

if (process.argv.includes('--after')) {
  const packaged = join('FinalApp', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', PKG);
  if (!hasBinary(packaged)) {
    console.error(`✗ The installer is missing ${PKG} — Share to phone via hotspot/Bluetooth would not work. Do not ship it.`);
    process.exit(1);
  }
  console.log(`✓ ${PKG} is inside the packaged app.`);
  process.exit(0);
}

if (hasBinary(dir)) {
  console.log(`✓ ${PKG} present.`);
  process.exit(0);
}

// Not on Windows: npm skipped it. Fetch the exact version koffi expects.
const version = JSON.parse(readFileSync('node_modules/koffi/package.json', 'utf8')).optionalDependencies?.[PKG];
if (!version) {
  console.error(`✗ Can't tell which ${PKG} version koffi needs.`);
  process.exit(1);
}
console.log(`${PKG} missing (building on ${process.platform}); fetching ${version}…`);
try {
  const tmp = join('node_modules', '.cache', 'koffi-win');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tgz = execFileSync('npm', ['pack', `${PKG}@${version}`, '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim().split('\n').pop();
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', dir, '--strip-components=1']);
} catch (err) {
  console.error(`✗ Couldn't fetch ${PKG}: ${err.message}`);
}
if (!hasBinary(dir)) {
  console.error(`✗ ${PKG} is still missing. Build the installer on Windows (or the GitHub workflow) instead.`);
  process.exit(1);
}
console.log(`✓ ${PKG} ${version} added.`);
