import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

const wasmPath = path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm');

const cases = [
  ['fun foo() =', '(source_file (function_declaration name: (identifier) (function_value_parameters)) (ERROR))'],
  ['x =', '(source_file (identifier) (ERROR))'],
  ['val x =', '(source_file (property_declaration (variable_declaration (identifier))) (ERROR))'],
  ['foo(', '(source_file (identifier) (ERROR))'],
  [
    'foo(1,',
    '(source_file (call_expression (identifier) (value_arguments (value_argument (number_literal)) (MISSING ")"))))',
  ],
  ['if (x)', '(source_file (if_expression condition: (identifier) consequence: (MISSING identifier)))'],
  [
    'val y by foo(',
    '(source_file (property_declaration (variable_declaration (identifier)) (property_delegate (identifier))) (ERROR))',
  ],
  [
    'fun f() = foo(',
    '(source_file (function_declaration name: (identifier) (function_value_parameters) (function_body (identifier))) (ERROR))',
  ],
];

test.each(cases)('preserves the completed structure of unfinished input %s', async (source, expected) => {
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasmPath));
  try {
    for (const padding of ['', '\n', ' ', '\t']) {
      const tree = parser.parse(source + padding)!;
      try {
        expect(tree.rootNode.toString(), JSON.stringify(source + padding)).toBe(expected);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
