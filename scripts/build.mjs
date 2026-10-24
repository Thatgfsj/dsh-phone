#!/usr/bin/env node
/**
 * Build dsh-phone.
 *
 * Layout:
 * - Host: every src/**.ts file (except client/ and shims/) is transpiled
 *   individually to lib/**.js as ESM with imports preserved and no bundling,
 *   so each source file stays small and debuggable. .ts import specifiers are
 *   rewritten to .js in the emitted files.
 * - Client: src/client/index.ts is bundled into one CJS factory and wrapped
 *   in window.__ModuleLoader__.load({ id, factory(require) }) as lib/client.js.
 * - Scaffold stage: there are no TypeScript sources yet, so the script must
 *   exit 0 and report that there is nothing to build.
 */
import { build } from 'esbuild'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')
const hostSkipDirs = new Set(['client', 'shims'])

async function collectHostEntries(dir, out) {
  if (!existsSync(dir)) return out
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (hostSkipDirs.has(entry.name)) continue
      await collectHostEntries(path, out)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

async function rewriteTsImports(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await rewriteTsImports(path)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    const code = await readFile(path, 'utf8')
    // Source uses .ts specifiers so node --test can run it directly; the
    // emitted ESM must import .js instead.
    const rewritten = code.replace(/(["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, '$1$2.js$3')
    if (rewritten !== code) await writeFile(path, rewritten)
  }
}

async function buildHost(entryPoints) {
  if (entryPoints.length === 0) return false
  await build({
    entryPoints,
    outdir: libDir,
    outbase: srcDir,
    bundle: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'info',
  })
  await rewriteTsImports(libDir)
  return true
}

async function buildClient(entry) {
  if (!existsSync(entry)) return false
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome110', 'safari16', 'firefox115'],
    // React and the @deepseek-ai/* packages are provided by the DSH host
    // through factory(require); they must never be bundled into the plugin.
    external: ['react', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
    minify: true,
    legalComments: 'none',
  })
  const code = result.outputFiles[0].text
  const wrapped =
    'window.__ModuleLoader__.load({\n' +
    '  id: ' + JSON.stringify(pkg.name) + ',\n' +
    '  factory(require) {\n' +
    '    var module = { exports: {} }\n' +
    '    var exports = module.exports\n' +
    '    ' + code.replace(/\n/g, '\n    ') + '\n' +
    '    return module.exports.default(require)\n' +
    '  },\n' +
    '})\n'
  await writeFile(join(libDir, 'client.js'), wrapped)
  return true
}

await rm(libDir, { recursive: true, force: true })
const hostEntries = await collectHostEntries(srcDir, [])
const clientEntry = join(srcDir, 'client', 'index.ts')
const hasClient = existsSync(clientEntry)

if (hostEntries.length === 0 && !hasClient) {
  console.log('[build] no TypeScript sources yet - nothing to build (scaffold stage)')
} else {
  await mkdir(libDir, { recursive: true })
  const hostBuilt = await buildHost(hostEntries)
  const clientBuilt = await buildClient(clientEntry)
  console.log(
    '[build] done: host=' +
      (hostBuilt ? hostEntries.length + ' file(s)' : 'skipped') +
      ', client=' +
      (clientBuilt ? 'bundled' : 'skipped'),
  )
}
