// Runs the full acceptance suite: every scripts/test-*.ts (via tsx) and every
// scripts/verify-*.mjs (via node), in sequence. Prints a PASS/FAIL summary and
// exits non-zero if any script fails. This is what `npm test` invokes.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(here)
  .filter((f) => /^test-.*\.ts$/.test(f) || /^verify-.*\.mjs$/.test(f))
  .sort();

const pass = [];
const fail = [];

for (const f of files) {
  const abs = join(here, f);
  // Run .ts via node's tsx loader and .mjs via node directly. Using
  // process.execPath (not npx.cmd) avoids EINVAL when spawning on Windows.
  const [cmd, args] = f.endsWith('.ts')
    ? [process.execPath, ['--import', 'tsx', abs]]
    : [process.execPath, [abs]];
  process.stdout.write(`\n=== ${f} ===\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  (r.status === 0 ? pass : fail).push(f);
}

console.log(`\n──────────── summary ────────────`);
console.log(`PASS (${pass.length}): ${pass.join(', ')}`);
console.log(`FAIL (${fail.length}): ${fail.join(', ') || '(none)'}`);
process.exit(fail.length ? 1 : 0);
