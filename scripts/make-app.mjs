#!/usr/bin/env node
/**
 * Build dist/Sonde.app — a double-clickable macOS bundle around the server.
 *
 * The bundle is a plain directory tree: a launcher script, an Info.plist, an
 * icon, and a copy of the app. No packaging tools and no dependencies; the
 * only external command is iconutil (ships with macOS) for the .icns, and the
 * build still succeeds without it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, execFileSync as run } from 'node:child_process';
import fsSync from 'node:fs';
import { iconPng } from './make-icons.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(ROOT, 'dist');
const APP = path.join(DIST, 'Sonde.app');
const CONTENTS = path.join(APP, 'Contents');
const MACOS = path.join(CONTENTS, 'MacOS');
const RESOURCES = path.join(CONTENTS, 'Resources');
const PAYLOAD = path.join(RESOURCES, 'app');

const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Sonde</string>
  <key>CFBundleDisplayName</key><string>Sonde</string>
  <key>CFBundleIdentifier</key><string>local.sonde.client</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Sonde</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- The UI is plain http on 127.0.0.1, which ATS blocks by default. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
`;

/*
 * Finder launches apps with a bare PATH, so node usually isn't on it. Look in
 * the places installers actually put it, newest nvm/fnm version first, and tell
 * the user plainly if there's nothing to run.
 */
const SHELL_LAUNCHER = `#!/bin/sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HERE/../Resources/app"

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for candidate in \\
    /opt/homebrew/bin/node \\
    /usr/local/bin/node \\
    /usr/bin/node \\
    "$HOME/.local/bin/node" \\
    /opt/local/bin/node
  do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  for manager in "$HOME/.nvm/versions/node" "$HOME/.fnm/node-versions" "$HOME/.volta/tools/image/node"; do
    [ -d "$manager" ] || continue
    newest="$(ls -1 "$manager" 2>/dev/null | sort -V | tail -1)"
    [ -n "$newest" ] || continue
    for suffix in "/bin/node" "/installation/bin/node"; do
      [ -x "$manager/$newest$suffix" ] && { echo "$manager/$newest$suffix"; return; }
    done
  done
  return 1
}

NODE="$(find_node)" || {
  osascript -e 'display alert "Node.js not found" message "Sonde needs Node.js 18 or newer.\\n\\nInstall it from nodejs.org, or with: brew install node" as critical'
  exit 1
}

SUPPORT="$HOME/Library/Application Support/Sonde"
mkdir -p "$SUPPORT"
export SONDE_DATA_DIR="$SUPPORT"

exec "$NODE" "$APP_DIR/server.js" --app >>"$SUPPORT/sonde.log" 2>&1
`;

/**
 * Compile the native shell.
 *
 * This is what makes Sonde behave like an application: the window belongs to
 * this binary, so the Dock icon activates it, Cmd-Tab finds it, and no browser
 * is involved. Without a Swift toolchain we fall back to the shell launcher,
 * where the window belongs to a browser instead.
 *
 * Host architecture only — cross-compiling the other slice needs pieces the
 * Command Line Tools don't reliably ship, and it hangs rather than failing.
 */
function buildNativeHost(target) {
  const source = path.join(ROOT, 'native', 'main.swift');
  const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
  const probe = path.join(DIST, 'sonde-probe');

  try {
    run('swiftc', [
      '-O', '-o', probe, source,
      '-framework', 'Cocoa', '-framework', 'WebKit',
      '-target', `${arch}-apple-macos11.3`,
    ], { stdio: 'pipe', timeout: 120_000 });
  } catch {
    return { arch: null, reason: 'no Swift toolchain' };
  }

  /*
   * Check the binary is actually allowed to run here before building the
   * bundle around it.
   *
   * Managed Macs often run application-control software (CyberArk EPM,
   * CrowdStrike and friends) that deletes locally compiled, ad-hoc-signed
   * executables the moment they are exec'd. The bundle would then look like it
   * simply does nothing when double-clicked, which is a miserable thing to
   * debug — so find out now and fall back to the browser launcher instead.
   */
  try {
    run(probe, ['--probe'], { stdio: 'pipe', timeout: 15_000 });
    if (!fsSync.existsSync(probe)) {
      return { arch: null, reason: 'blocked by endpoint security (binary removed on launch)' };
    }
  } catch {
    const removed = !fsSync.existsSync(probe);
    return {
      arch: null,
      reason: removed
        ? 'blocked by endpoint security (binary removed on launch)'
        : 'the compiled host would not run here',
    };
  }

  fsSync.copyFileSync(probe, target);
  fsSync.chmodSync(target, 0o755);
  fsSync.rmSync(probe, { force: true });
  return { arch, reason: null };
}

/** Copy a file or directory tree, skipping build and runtime noise. */
async function copy(from, to) {
  const skip = new Set(['node_modules', 'dist', 'data', '.git', '.DS_Store']);
  const stat = await fs.stat(from);
  if (stat.isDirectory()) {
    if (skip.has(path.basename(from))) return;
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from)) await copy(path.join(from, entry), path.join(to, entry));
  } else {
    await fs.copyFile(from, to);
  }
}

async function buildIcon() {
  const iconset = path.join(DIST, 'icon.iconset');
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });

  // The sizes iconutil expects, each also at @2x.
  for (const size of [16, 32, 128, 256, 512]) {
    await fs.writeFile(path.join(iconset, `icon_${size}x${size}.png`), iconPng(size));
    await fs.writeFile(path.join(iconset, `icon_${size}x${size}@2x.png`), iconPng(size * 2));
  }

  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(RESOURCES, 'icon.icns')]);
    await fs.rm(iconset, { recursive: true, force: true });
    return true;
  } catch {
    console.warn('  (iconutil unavailable — bundle will use the default icon)');
    return false;
  }
}

/* ------------------------------- build ------------------------------- */

console.log('Building Sonde.app…');
await fs.rm(APP, { recursive: true, force: true });
await fs.mkdir(MACOS, { recursive: true });
await fs.mkdir(PAYLOAD, { recursive: true });

await fs.writeFile(path.join(CONTENTS, 'Info.plist'), INFO_PLIST);
const executable = path.join(MACOS, 'Sonde');
const { arch: nativeArch, reason } = buildNativeHost(executable);
if (!nativeArch) {
  console.warn(`  native window unavailable — ${reason}.`);
  console.warn('  falling back to a browser window; see the README for the');
  console.warn('  "Install app" route, which gives a proper Dock icon.');
  await fs.writeFile(executable, SHELL_LAUNCHER, { mode: 0o755 });
}

for (const entry of ['server.js', 'package.json', 'public']) {
  await copy(path.join(ROOT, entry), path.join(PAYLOAD, entry));
}

const hasIcon = await buildIcon();

/*
 * Ad-hoc sign the bundle.
 *
 * Not optional: on Apple Silicon an unsigned binary is refused outright, and
 * swiftc's own linker signature leaves Info.plist unbound — the binary runs but
 * the *bundle* doesn't, which looks exactly like the app silently not starting.
 * Signing the bundle binds the plist and makes double-clicking work.
 */
let signed = false;
try {
  run('codesign', ['--force', '--sign', '-', APP], { stdio: 'pipe' });
  signed = true;
} catch (err) {
  console.warn('  codesign failed — the app may refuse to launch:', err.message.split('\n')[0]);
}

// Ask Finder to notice the new bundle rather than showing a stale icon.
try {
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', APP], { stdio: 'ignore' });
} catch { /* optional */ }

console.log(`\n  ${path.relative(process.cwd(), APP)}`);
console.log(`  icon: ${hasIcon ? 'bundled' : 'default'}`);
console.log(`  window: ${nativeArch ? `native ${nativeArch}, no browser` : 'browser'}`);
console.log(`  signed: ${signed ? 'ad-hoc' : 'NO — launching will fail'}`);
console.log('  double-click it, or drag it to /Applications\n');
console.log('  workspace: ~/Library/Application Support/Sonde/workspace.json\n');
