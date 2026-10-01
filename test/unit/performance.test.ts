import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';

const Root = path.join(import.meta.dirname, '../..');
// The Wasm build is the one the package ships.
const WasmPath = path.join(Root, 'tree-sitter-kotlin.wasm');
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(WasmPath));

// Only `bun run build/ci` rebuilds the Wasm build, so a check against a stale one would pass after a source
// edit that brings the slowdown back.
test('uses a Wasm build built from the current parser', () => {
  // src/parser.c is generated from grammar.js, so an edit to the grammar alone also makes the Wasm build stale.
  const sources = ['grammar.js', 'src/parser.c', 'src/scanner.c'].map(
    (name) => fs.statSync(path.join(Root, name)).mtimeMs
  );
  expect(
    Math.max(...sources) > fs.statSync(WasmPath).mtimeMs,
    'grammar.js or src/ changed after the Wasm build was built; run `bun run build/ci`'
  ).toBe(false);
});

// Consumers parse files being edited, so recovering from many errors must stay linear: ten times the lines take
// about ten times as long, against a hundred times for quadratic recovery. The ratio catches a cost that grows faster
// than the input even on a slow CI runner; it would pass a parser that is uniformly slower, so the larger parse also has
// a generous ceiling, about 35 times the 0.15 s of CPU time it takes here. The parses are timed in the CPU time of this
// test file's process (see `pool` in vitest.config.mts), not in wall-clock time, which the test files running
// alongside inflate unevenly. That CPU time also counts the engine's compiler and garbage collector threads, which
// dominate parses of about 10 ms: a ratio of 1,000 to 10,000 lines ranged from 8 to 29 for the same parser. So the
// sizes are 2,000 and 20,000 lines (ratios of 9.6 to 13.8), measured after warm-up parses and in alternation, each
// keeping its fastest run; 18 leaves a margin over that and fails for growth of n^1.25 or faster.
test('recovers from an error on each line in linear time', { timeout: 60_000 }, () => {
  const small = '$ a\n'.repeat(2000);
  const large = '$ a\n'.repeat(20_000);
  parseCpuTime(large);
  parseCpuTime(large);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 5; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small));
    largeFastest = Math.min(largeFastest, parseCpuTime(large));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
  // process.cpuUsage reports microseconds.
  expect(largeFastest).toBeLessThan(5_000_000);
});

function parseCpuTime(source: string): number {
  const start = process.cpuUsage();
  const tree = parser.parse(source);
  const { system, user } = process.cpuUsage(start);
  if (!tree) throw new Error('The parser returned no tree');
  const { hasError } = tree.rootNode;
  tree.delete();
  expect(hasError).toBe(true);
  return system + user;
}
