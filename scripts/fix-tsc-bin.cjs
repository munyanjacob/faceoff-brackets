'use strict';

/**
 * Guards against a real, verified npm bin-linking collision introduced by
 * adding `@typescript/typescript6` as a devDependency (see issue #39 and
 * _docs/outdated/architecture.md for the full story).
 *
 * `@typescript/typescript6` depends on `@typescript/old`, which is simply
 * `typescript@6.x` installed under an alias name. That package declares
 * `bin: { "tsc": "./bin/tsc" }` - the exact same bin name as this repo's
 * real, pinned `typescript@^7.0.2`. Both packages get hoisted to the
 * top-level `node_modules`, and npm's bin linker can only point the
 * shared `node_modules/.bin/tsc` shim at ONE of them. Which one wins is
 * an npm install-order detail, not something this repo can rely on - and
 * empirically, right after `npm install`, it picked `@typescript/old`
 * (TypeScript 6.0.3), silently hijacking `npx tsc` away from the pinned
 * TypeScript 7.0.2.
 *
 * This does NOT affect `next build`'s own internal type-check
 * (`getTypeScriptPackageInfo()` in next/dist/lib/typescript/runTypeScriptCli.js
 * resolves the `typescript` package by module name and reads its `bin`
 * field directly from its own package.json - it never touches
 * `node_modules/.bin`), but it does break plain `npx tsc`/`tsc` for
 * anyone using it directly, which is exactly the "no silent version
 * discrepancy" bar this fix is held to.
 *
 * Fix: after every `npm install` (wired into "postinstall"), force
 * `node_modules/.bin/tsc{,.cmd,.ps1}` back to point at the real,
 * pinned `typescript` package - regardless of which package's bin
 * happened to win npm's internal linking race. Idempotent and safe to
 * run any number of times.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = process.cwd();
const TYPESCRIPT_DIR = path.join(PROJECT_ROOT, 'node_modules', 'typescript');
const BIN_DIR = path.join(PROJECT_ROOT, 'node_modules', '.bin');

function fail(message) {
  process.stderr.write(`[fix-tsc-bin] ${message}\n`);
  process.exit(1);
}

const packageJsonPath = path.join(TYPESCRIPT_DIR, 'package.json');
if (!fs.existsSync(packageJsonPath)) {
  fail(`node_modules/typescript is missing (expected the pinned TypeScript compiler). Ran \`npm install\`?`);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const tscBin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin && packageJson.bin.tsc;

if (!tscBin) {
  fail(`node_modules/typescript@${packageJson.version} does not declare a "tsc" bin - nothing to fix, but that's unexpected.`);
}

const realTscTarget = path.join(TYPESCRIPT_DIR, tscBin);
if (!fs.existsSync(realTscTarget)) {
  fail(`Resolved tsc target does not exist: ${realTscTarget}`);
}

// Relative-from-.bin-dir path, POSIX-slash form, as npm's own shims use.
const relFromBin = path.relative(BIN_DIR, realTscTarget).split(path.sep).join('/');

const shShim = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=\`cygpath -w "$basedir"\`
        fi
    ;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/${relFromBin}" "$@"
else
  exec node  "$basedir/${relFromBin}" "$@"
fi
`;

const cmdShim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relFromBin.split('/').join('\\')}" %*
`;

const ps1Shim = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/${relFromBin}" $args
  } else {
    & "$basedir/node$exe"  "$basedir/${relFromBin}" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/${relFromBin}" $args
  } else {
    & "node$exe"  "$basedir/${relFromBin}" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;

fs.writeFileSync(path.join(BIN_DIR, 'tsc'), shShim, { mode: 0o755 });
fs.writeFileSync(path.join(BIN_DIR, 'tsc.cmd'), cmdShim);
fs.writeFileSync(path.join(BIN_DIR, 'tsc.ps1'), ps1Shim);

process.stdout.write(`[fix-tsc-bin] node_modules/.bin/tsc now points at typescript@${packageJson.version} (${realTscTarget})\n`);
