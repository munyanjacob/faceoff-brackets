'use strict';

/**
 * Lint-only TypeScript compiler swap.
 *
 * Why this exists: `typescript-eslint` (and everything under
 * `@typescript-eslint/*`, plus sibling helper packages such as
 * `ts-api-utils`) is built against the classic TypeScript <6.1 Compiler
 * API (`ts.createProgram`, `ts.SyntaxKind`, etc). This repo pins
 * `typescript@^7.0.2` (see _docs/outdated/architecture.md), and TS 7's
 * package no longer exports that API at all - only the new
 * `./unstable/*` native-compiler entry points. Loading `typescript-eslint`
 * against real TS 7 throws immediately (its own version guard, or a raw
 * crash further down the stack if you bypass the guard).
 *
 * The only real fix is Microsoft's documented "side-by-side" package,
 * `@typescript/typescript6`, which re-exports the TS 6.0 Compiler API.
 * Aliasing the bare `typescript` name to it globally (via package.json)
 * *works* for lint, but was proven to also divert `next build`'s internal
 * type-check (Next's `getTypeScriptPackageInfo()` resolves whatever
 * `typescript` currently points at) onto 6.0.2 instead of the pinned
 * 7.0.2 - a silent, real regression, not a hypothetical one.
 *
 * So instead of touching the global `typescript` resolution, this script
 * patches Node's CJS resolver *for the one process running eslint*, and
 * only for `require('typescript')` calls that originate from inside a
 * package that is (a) part of `typescript-eslint`'s own dependency graph
 * and (b) itself declares a dependency/peerDependency on `typescript`.
 *
 * That second condition matters: a plain "is the requesting file under a
 * directory named typescript-eslint/@typescript-eslint" check is not
 * enough. `ts-api-utils` - a dependency of `@typescript-eslint/type-utils`
 * that also does `require('typescript')` - is hoisted to the top-level
 * `node_modules/ts-api-utils`, with no `typescript-eslint` in its path at
 * all. So this script computes the actual dependency closure (walking
 * `dependencies`/`peerDependencies`/`optionalDependencies` the same way
 * Node's own resolver would) instead of guessing from directory names.
 *
 * Every `require('typescript')` call that does NOT originate from within
 * that computed closure - including calls from any other tool that might
 * happen to run in this same process, and definitely from any separate
 * `tsc`/`next build` process, which never loads this file at all - is
 * completely untouched.
 *
 * Load this via `--require` (or `NODE_OPTIONS`) only for the `lint`
 * script - see the "lint" entry in package.json.
 */

const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const SHIM_TARGET = '@typescript/typescript6';
const PROJECT_ROOT = process.cwd();
const DEBUG = process.env.LINT_TS_SHIM_DEBUG === '1';

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Find every installed package directory named `typescript-eslint` or
 * `@typescript-eslint/*`, wherever npm actually put it (top-level or
 * nested inside another package's own node_modules). These are the seeds
 * for the dependency-closure walk below.
 */
function findFamilySeeds(nodeModulesDir, seeds) {
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const full = path.join(nodeModulesDir, entry.name);

    if (entry.name.startsWith('@')) {
      let scoped;
      try {
        scoped = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        scoped = [];
      }
      for (const s of scoped) {
        if (!s.isDirectory()) continue;
        const pkgDir = path.join(full, s.name);
        if (`${entry.name}/${s.name}`.startsWith('@typescript-eslint/')) {
          seeds.add(pkgDir);
        }
        const nested = path.join(pkgDir, 'node_modules');
        if (fs.existsSync(nested)) findFamilySeeds(nested, seeds);
      }
      continue;
    }

    if (entry.name === 'typescript-eslint') {
      seeds.add(full);
    }
    const nested = path.join(full, 'node_modules');
    if (fs.existsSync(nested)) findFamilySeeds(nested, seeds);
  }
}

function findPackageRootFromFile(filename, expectedName) {
  let dir = path.dirname(filename);
  while (true) {
    const pkg = readPackageJson(dir);
    if (pkg && pkg.name === expectedName) return dir;
    const parentDir = path.dirname(dir);
    if (parentDir === dir) return null; // hit filesystem root without a match
    dir = parentDir;
  }
}

/**
 * Resolve the installed root directory of `name` as seen from `fromDir`,
 * the way Node's own resolver would find it (respecting nesting/hoisting).
 * Some packages (e.g. `ts-api-utils`) declare an `exports` map that does
 * not expose `./package.json` as a subpath, so resolving that subpath
 * directly can fail even though the package itself resolves fine -
 * resolve the package's actual entry point instead and walk up to find
 * its package.json.
 */
function resolvePackageRoot(name, fromDir) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`, { paths: [fromDir] }));
  } catch {
    // fall through to the entry-point-based lookup below
  }
  try {
    const entryFile = require.resolve(name, { paths: [fromDir] });
    return findPackageRootFromFile(entryFile, name);
  } catch {
    return null;
  }
}

const DEP_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

function declaresTypescript(pkg) {
  return !!pkg && DEP_SECTIONS.some((section) => pkg[section] && Object.prototype.hasOwnProperty.call(pkg[section], 'typescript'));
}

/**
 * BFS over `typescript-eslint`'s real, installed dependency graph.
 * Returns the set of package root directories that (a) are reachable
 * from `typescript-eslint`/`@typescript-eslint/*` and (b) themselves
 * declare a dependency on `typescript` - i.e. packages that might
 * plausibly do `require('typescript')`.
 */
function buildRedirectClosure(seedRoots) {
  const closure = new Set(seedRoots); // seeds are known to be the family itself
  const visited = new Set();
  const queue = [...seedRoots];

  while (queue.length > 0) {
    const root = queue.shift();
    if (visited.has(root)) continue;
    visited.add(root);

    const pkg = readPackageJson(root);
    if (!pkg) continue;

    const depNames = new Set();
    for (const section of DEP_SECTIONS) {
      if (pkg[section]) {
        for (const depName of Object.keys(pkg[section])) depNames.add(depName);
      }
    }

    for (const depName of depNames) {
      if (depName === 'typescript') continue; // the redirect target, not a graph member
      const depRoot = resolvePackageRoot(depName, root);
      if (!depRoot || visited.has(depRoot)) continue;

      const depPkg = readPackageJson(depRoot);
      if (declaresTypescript(depPkg)) {
        closure.add(depRoot);
      }
      queue.push(depRoot);
    }
  }

  return closure;
}

const familySeeds = new Set();
findFamilySeeds(path.join(PROJECT_ROOT, 'node_modules'), familySeeds);

if (familySeeds.size === 0) {
  // Fail loudly rather than silently doing nothing: if this ever fires,
  // typescript-eslint's install layout changed and this shim needs a
  // look, not a quiet no-op that leaves eslint crashing the same way it
  // did before this fix.
  process.stderr.write(
    '[lint-typescript-shim] WARNING: found no typescript-eslint/@typescript-eslint packages under node_modules. ' +
      'The lint-only TypeScript redirect is not active; eslint may crash with the TS 7.0 incompatibility error.\n',
  );
}

const redirectDirs = buildRedirectClosure(familySeeds);

if (DEBUG) {
  process.stderr.write(`[lint-typescript-shim] redirect closure (${redirectDirs.size} package dirs):\n`);
  for (const dir of redirectDirs) {
    process.stderr.write(`  - ${path.relative(PROJECT_ROOT, dir)}\n`);
  }
}

function isUnderRedirectDir(filename) {
  for (const dir of redirectDirs) {
    if (filename === dir || filename.startsWith(dir + path.sep)) return true;
  }
  return false;
}

function isRequestForTypescript(request) {
  return request === 'typescript' || request.startsWith('typescript/');
}

function rewriteRequest(request) {
  if (request === 'typescript') return SHIM_TARGET;
  // e.g. 'typescript/lib/typescript.js' -> '@typescript/typescript6/lib/typescript.js'
  return SHIM_TARGET + request.slice('typescript'.length);
}

let redirectCount = 0;
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
  if (isRequestForTypescript(request) && parent && typeof parent.filename === 'string' && isUnderRedirectDir(parent.filename)) {
    const redirected = rewriteRequest(request);
    const resolved = originalResolveFilename.call(this, redirected, parent, isMain, options);
    redirectCount += 1;
    if (DEBUG) {
      process.stderr.write(
        `[lint-typescript-shim] ${request} -> ${redirected} (requested from ${path.relative(PROJECT_ROOT, parent.filename)})\n`,
      );
    }
    return resolved;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

process.on('exit', () => {
  if (DEBUG) {
    process.stderr.write(`[lint-typescript-shim] redirected ${redirectCount} require('typescript') call(s)\n`);
  }
});
