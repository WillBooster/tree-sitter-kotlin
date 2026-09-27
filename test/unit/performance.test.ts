import { expect, test } from 'bun:test';
import path from 'node:path';

import Parser from 'tree-sitter';

// Bun cannot use node-gyp-build's lookup, so the addon that `bun install` builds is loaded directly.
const Kotlin = require(path.join(import.meta.dir, '../../build/Release/tree_sitter_kotlin_binding.node')) as Parser.Language;
const parser = new Parser();
parser.setLanguage(Kotlin);

// Consumers parse files being edited, so recovering from many errors must stay linear. Linear recovery
// takes about 0.2 s here; a scanner that read to the end of the input on each attempt took 50 s.
test('recovers from an error on each of 10,000 lines in linear time', () => {
  const start = performance.now();
  expect(parser.parse('$ a\n'.repeat(10_000)).rootNode.hasError).toBe(true);
  expect(performance.now() - start).toBeLessThan(3000);
});
