/// <reference types="vite/client" />
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import kotlinUrl from '../../tree-sitter-kotlin.wasm?url';

test('parses in a browser, loading the Wasm files over HTTP', async () => {
  await Parser.init({ locateFile: () => runtimeUrl });
  const parser = new Parser();
  parser.setLanguage(await Language.load(kotlinUrl));
  expect(parser.parse('val x = 1\n')?.rootNode.toString()).toBe(
    '(source_file (property_declaration (variable_declaration (identifier)) (number_literal)))'
  );
});
