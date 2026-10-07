import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { generationInputMtime } from '../helpers/generationInputs.js';

import { Language, Parser } from '@willbooster/web-tree-sitter';

const Root = path.join(import.meta.dirname, '../..');
// The Wasm build is the one the package ships.
const WasmPath = path.join(Root, 'tree-sitter-kotlin.wasm');
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(WasmPath));

// The tests load the existing Wasm build, so a check against a stale one would miss an edit that restores the slowdown.
test('uses a Wasm build built from the current parser', () => {
  const sources = ['grammar.js', 'src/parser.c', 'src/scanner.c'].map(
    (name) => fs.statSync(path.join(Root, name)).mtimeMs
  );
  expect(
    Math.max(generationInputMtime(Root), ...sources) > fs.statSync(WasmPath).mtimeMs,
    'generation inputs or src/ changed after the Wasm build was built; run `bun run build/ci`'
  ).toBe(false);
});

// Consumers parse files being edited, so recovering from many errors must stay linear: ten times the lines take about
// ten times as long, against a hundred times for quadratic recovery. The ratio catches a cost that grows faster than
// the input even on a slow CI runner; it would pass a parser that is uniformly slower, so the larger parse also has a
// generous ceiling, about 35 times the 0.15 s of CPU time it takes here. The parses are timed in the CPU time of the
// thread that runs them: wall-clock time is inflated unevenly by the test files running alongside, and the process's
// CPU time also counts the engine's background threads, which compile the Wasm build and collect garbage during the
// parses. With process CPU time, the ratio of 1,000 to 10,000 lines ranged from 7 to 25 locally, and that of 2,000 to
// 20,000 lines reached 24 on a CI runner. With thread CPU time, 2,000 and 20,000 lines measured after warm-up parses
// and in alternation, each keeping its fastest run, give 9.8 to 11.7 locally; 18 leaves a margin over that and fails
// for growth faster than about n^1.25.
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
  // process.threadCpuUsage reports microseconds.
  expect(largeFastest).toBeLessThan(5_000_000);
});

test('recovers from repeated unfinished destructuring types in linear time', { timeout: 60_000 }, () => {
  const small = `fun f() {\n${'  xs.map { (a, b):\n  println(i\n'.repeat(500)}}\n`;
  const large = `fun f() {\n${'  xs.map { (a, b):\n  println(i\n'.repeat(5000)}}\n`;
  parseCpuTime(large);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 3; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small));
    largeFastest = Math.min(largeFastest, parseCpuTime(large));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
  expect(largeFastest).toBeLessThan(5_000_000);
});

function parseCpuTime(source: string): number {
  const start = process.threadCpuUsage();
  const tree = parser.parse(source);
  const { system, user } = process.threadCpuUsage(start);
  if (!tree) throw new Error('The parser returned no tree');
  const { hasError } = tree.rootNode;
  tree.delete();
  expect(hasError).toBe(true);
  return system + user;
}
