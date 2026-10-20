#!/usr/bin/env node
// Puts bloot apps inside the qooti build (MD/bloot-apps-licensing.md §13): qooti's
// account comes from bloot apps, so every qooti install brings it along.
//
//   Windows  src-tauri/bloot-apps/bloot-apps-setup.exe   (run silently by the NSIS
//            hook, windows/nsis-hooks.nsh) + windows/bloot-apps-version.nsh
//   macOS    src-tauri/bloot-apps/bloot apps.app         (copied into Applications
//            on qooti's first launch, bloot_hub.rs)
//
// Usage (before `tauri build`; release.yml runs it for macOS):
//   node scripts/fetch-bloot-apps.mjs                 latest release, this platform
//   node scripts/fetch-bloot-apps.mjs --platform darwin-aarch64
//   node scripts/fetch-bloot-apps.mjs --from <setup.exe | .app.tar.gz> --version 0.1.0
//
// Releases are checked against the bloot release keys exactly like bloot apps checks
// what it installs. --from is for local testing with an unsigned build.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { verifySignature } = require('./minisign.cjs')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'src-tauri', 'bloot-apps')
const VERSION_NSH = path.join(ROOT, 'src-tauri', 'windows', 'bloot-apps-version.nsh')
/** bloot apps' release manifest (Tauri latest.json shape), published with each bloot apps release. */
const MANIFEST = 'https://api.bloot.app/download/bloot-apps-latest.json'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--from') args.from = path.resolve(process.argv[++i])
  else if (a === '--version') args.version = process.argv[++i]
  else if (a === '--platform') args.platform = process.argv[++i]
  else fail(`Unknown argument: ${a}`)
}
const platform = args.platform || (process.platform === 'win32' ? 'windows-x86_64'
  : process.platform === 'darwin' ? `darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}` : fail('Builds are made on Windows or macOS.'))
const windows = platform.startsWith('windows')

let file, version
if (args.from) {
  if (!fs.existsSync(args.from)) fail(`No such file: ${args.from}`)
  file = args.from
  version = args.version || path.basename(file).match(/_(\d+\.\d+\.\d+)_/)?.[1] || fail('Pass --version (it isn\'t in the file name).')
  log(`Using ${path.basename(file)} (${version}) — local file, signature not checked.`)
} else {
  const res = await fetch(MANIFEST)
  if (!res.ok) fail(`Couldn't read ${MANIFEST} (HTTP ${res.status}). Is bloot apps released yet? For a local build use --from.`)
  const m = await res.json()
  const p = m.platforms?.[platform] || fail(`bloot apps ${m.version} has no ${platform} build.`)
  version = m.version
  log(`Downloading bloot apps ${version} for ${platform}…`)
  const dl = await fetch(p.url)
  if (!dl.ok) fail(`Download failed: HTTP ${dl.status} for ${p.url}`)
  const bytes = Buffer.from(await dl.arrayBuffer())
  try {
    log(`  Signed with the bloot release key ${verifySignature(bytes, p.signature)}.`)
  } catch (e) {
    fail(`bloot apps ${version} fails the signature check (${e.message}) — not bundling it.`)
  }
  fs.mkdirSync(path.join(ROOT, 'src-tauri', 'target'), { recursive: true })
  file = path.join(ROOT, 'src-tauri', 'target', path.basename(new URL(p.url).pathname))
  fs.writeFileSync(file, bytes)
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
if (windows) {
  fs.copyFileSync(file, path.join(OUT, 'bloot-apps-setup.exe'))
  fs.writeFileSync(VERSION_NSH, `; Written by scripts/fetch-bloot-apps.mjs — the bloot apps version inside this build.\n!define BLOOT_APPS_VERSION "${version}"\n`)
  log(`✓ src-tauri/bloot-apps/bloot-apps-setup.exe (${version})`)
} else {
  // The updater archive (.app.tar.gz) holds exactly "bloot apps.app".
  const r = spawnSync('tar', ['-xzf', file, '-C', OUT], { stdio: 'inherit' })
  if (r.status !== 0 || !fs.existsSync(path.join(OUT, 'bloot apps.app'))) fail(`Couldn't unpack ${path.basename(file)} into "bloot apps.app".`)
  log(`✓ src-tauri/bloot-apps/bloot apps.app (${version})`)
}

function log(msg) { console.log(msg) }
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1) }
