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

// Consumers parse files being edited, so recovering from many errors must stay linear. Linear recovery
// takes about 0.2 s here; a scanner that read to the end of the input on each attempt took 50 s. The timeout
// exceeds Vitest's 5 s default so that a slow run fails on the elapsed time it reports, not on the timeout.
test('recovers from an error on each of 10,000 lines in linear time', { timeout: 60_000 }, () => {
  const start = performance.now();
  const tree = parser.parse('$ a\n'.repeat(10_000));
  const elapsed = performance.now() - start;
  if (!tree) throw new Error('The parser returned no tree');
  const { hasError } = tree.rootNode;
  tree.delete();
  expect(hasError).toBe(true);
  expect(elapsed).toBeLessThan(3000);
});
