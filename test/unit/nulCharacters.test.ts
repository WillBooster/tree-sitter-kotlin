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

test('parses escapes and string templates next to NUL characters', () => {
  const tree = parser.parse('val h = "\\\0"\nval i = "x\0${y}"\nval j = "x$\0"\n');
  if (!tree) throw new Error('The parser returned no tree');
  const root = tree.rootNode.toString();
  tree.delete();
  expect(root).toBe(
    '(source_file (property_declaration (variable_declaration (identifier)) (string_literal (string_content))) (property_declaration (variable_declaration (identifier)) (string_literal (string_content) (interpolation (identifier)))) (property_declaration (variable_declaration (identifier)) (string_literal (string_content) (string_content) (string_content))))'
  );
});

test('parses escapes and string content after escapes and templates next to NUL characters', () => {
  const tree = parser.parse('val k = \'\\\0\'\nval l = "\\n\0"\nval m = "${x}\0y"\n');
  if (!tree) throw new Error('The parser returned no tree');
  const root = tree.rootNode.toString();
  tree.delete();
  expect(root).toBe(
    '(source_file (property_declaration (variable_declaration (identifier)) (character_literal (escape_sequence))) (property_declaration (variable_declaration (identifier)) (string_literal (escape_sequence) (string_content))) (property_declaration (variable_declaration (identifier)) (string_literal (interpolation (identifier)) (string_content))))'
  );
});

test('parses a shebang line that contains a NUL character', () => {
  const tree = parser.parse('#!/usr/bin/env k\0s\nval n = 1\n');
  if (!tree) throw new Error('The parser returned no tree');
  const root = tree.rootNode.toString();
  tree.delete();
  expect(root).toBe(
    '(source_file (shebang) (property_declaration (variable_declaration (identifier)) (number_literal)))'
  );
});
