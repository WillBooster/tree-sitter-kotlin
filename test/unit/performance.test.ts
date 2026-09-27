import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import Parser from 'tree-sitter';

const Root = path.join(import.meta.dir, '../..');
// Bun cannot use node-gyp-build's lookup, so the addon that `bun install` builds is loaded directly.
const AddonPath = path.join(Root, 'build/Release/tree_sitter_kotlin_binding.node');
const parser = new Parser();
parser.setLanguage(createRequire(import.meta.url)(AddonPath) as Parser.Language);

// Only `bun install` and `bun run build/ci` rebuild the addon, so a check against a stale one would pass
// after a source edit that brings the slowdown back.
test('uses a Node.js addon built from the current parser', () => {
  // src/parser.c is generated from grammar.js, so an edit to the grammar alone also makes the addon stale.
  const sources = ['grammar.js', 'src/parser.c', 'src/scanner.c'].map(
    (name) => fs.statSync(path.join(Root, name)).mtimeMs
  );
  expect(
    Math.max(...sources) > fs.statSync(AddonPath).mtimeMs,
    'grammar.js or src/ changed after the addon was built; run `bun run build/ci`'
  ).toBe(false);
});

// Consumers parse files being edited, so recovering from many errors must stay linear. Linear recovery
// takes about 0.2 s here; a scanner that read to the end of the input on each attempt took 50 s.
test('recovers from an error on each of 10,000 lines in linear time', () => {
  const start = performance.now();
  expect(parser.parse('$ a\n'.repeat(10_000)).rootNode.hasError).toBe(true);
  expect(performance.now() - start).toBeLessThan(3000);
});
