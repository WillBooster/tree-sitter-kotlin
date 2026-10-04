import path from 'node:path';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, expect, test } from 'vitest';

let parser: Parser;
let query: Query;

beforeAll(async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  parser = new Parser();
  parser.setLanguage(language);
  query = new Query(language, '(class_member_declaration) @member');
});

afterAll(() => {
  query.delete();
  parser.delete();
});

test('matches same-line class members through their supertype, including nested members', () => {
  const members = ['fun first() {}', 'class Nested { fun inner() {} fun last() {} }', 'fun final() {}'];
  const expected = [members[0], members[1], 'fun inner() {}', 'fun last() {}', members[2]];
  for (const separator of [' ', '; ', '\n']) {
    const tree = parser.parse(`class C { ${members.join(separator)} }`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(expected);
    } finally {
      tree.delete();
    }
  }
});

test('requires a separator after properties even when nested bodies contain adjacent functions', () => {
  for (const source of [
    'class C { fun first() {} val x = 1 val y = 2 }',
    'class C { val x = object { fun first() {} fun last() {} } fun next() {} }',
  ]) {
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
    } finally {
      tree.delete();
    }
  }
});

test('preserves adjacent contextual members and their query captures', () => {
  for (const members of [
    ['init {}', 'init {}', 'fun f() {}'],
    ['constructor() {}', 'constructor(x: Int) {}', 'fun f() {}'],
    ['fun f() {}', 'companion object {}'],
    ['fun f() {}', 'private constructor() {}'],
  ]) {
    for (const separator of [' ', ' /* boundary */ ', '\n', '; ']) {
      const source = `class C { ${members.join(separator)} }`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(
          query.captures(tree.rootNode).map(({ node }) => node.text),
          source
        ).toEqual(members);
      } finally {
        tree.delete();
      }
    }
  }
});

test('keeps contextual infix calls inside property initializers', () => {
  for (const expression of ['1 init {}', '1 companion object {}']) {
    const source = `class C { val x = ${expression} }`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      expect(query.captures(tree.rootNode).map(({ node }) => node.type)).toEqual(['property_declaration']);
      expect(tree.rootNode.descendantsOfType('infix_expression').map((node) => node.text)).toEqual([expression]);
    } finally {
      tree.delete();
    }
  }
});
