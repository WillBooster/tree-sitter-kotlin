import { expect, test } from 'vitest';
import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';

// Corpus files cannot hold a NUL character without Git treating them as binary, so these cases live here.
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm')));

test('parses comments that contain NUL characters', () => {
  const tree = parser.parse('fun f() {\n  // a\0b\n  /* c\0d */ g()\n}\n');
  if (!tree) throw new Error('The parser returned no tree');
  const root = tree.rootNode.toString();
  tree.delete();
  expect(root).toBe(
    '(source_file (function_declaration name: (identifier) (function_value_parameters) (function_body (block (line_comment) (block_comment) (call_expression (identifier) (value_arguments))))))'
  );
});

test('parses strings and character literals that contain NUL characters', () => {
  const tree = parser.parse('val a = "b\0c"\nval d = """e\0f"""\nval g = \'\0\'\n');
  if (!tree) throw new Error('The parser returned no tree');
  const root = tree.rootNode.toString();
  tree.delete();
  expect(root).toBe(
    '(source_file (property_declaration (variable_declaration (identifier)) (string_literal (string_content))) (property_declaration (variable_declaration (identifier)) (multiline_string_literal (string_content))) (property_declaration (variable_declaration (identifier)) (character_literal)))'
  );
});
