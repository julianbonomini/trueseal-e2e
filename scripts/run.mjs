import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The system lane IS the Scenario Suite against the TypeScript driver
// (E2E-1: the lifecycle scenarios run through the shared Scenario Driver).
// Kept as a separate entry point so existing CI invocations keep working.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  process.execPath,
  [resolve(repo, 'scripts', 'run-scenarios.mjs'), 'ts', ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
