// Loads every case file, then runs what matches.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const verbose = args.includes('-v');
const kAt = args.indexOf('-k');
const pattern = kAt >= 0 ? args[kAt + 1] : null;

const files = readdirSync(join(here, 'cases')).filter((f) => f.endsWith('.mjs')).sort();
for (const f of files) {
  console.log(`\n${f.replace('.mjs', '')}`);
  await import(pathToFileURL(join(here, 'cases', f)).href);
}
process.exit(await run(pattern, verbose));
