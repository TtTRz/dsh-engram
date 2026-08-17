import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Post-build fix: esbuild (via tsup) externalizes recent `node:` builtins
 * such as `node:sqlite` without their `node:` prefix, producing a broken
 * `import … from "sqlite"`. Rewrite those bare specifiers back to their
 * `node:`-prefixed form so the ESM bundle resolves against Node, not npm.
 *
 * Usage: node scripts/fix-node-builtins.mjs <bundle.js>
 */

const NODE_BUILTINS = new Set(['sqlite'])

function fixFile(path) {
  let code = readFileSync(path, 'utf8')
  for (const builtin of NODE_BUILTINS) {
    code = code
      .split(`"${builtin}"`).join(`"node:${builtin}"`)
      .split(`'${builtin}'`).join(`'node:${builtin}'`)
  }
  writeFileSync(path, code)
  return code
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]
  if (target === undefined) {
    console.error('usage: fix-node-builtins.mjs <bundle.js>')
    process.exit(1)
  }
  fixFile(target)
}
