import path from 'node:path';

import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';
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
    ['fun f() {}', 'private /* outer /* nested */ */ constructor() {}'],
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

test('keeps contextual infix calls inside member expressions', () => {
  for (const expression of ['1 init {}', '1 companion object {}']) {
    const source = `class C { val x = ${expression}; fun f() = ${expression} }`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      expect(query.captures(tree.rootNode).map(({ node }) => node.type)).toEqual([
        'property_declaration',
        'function_declaration',
      ]);
      expect(tree.rootNode.descendantsOfType('infix_expression').map((node) => node.text)).toEqual([
        expression,
        expression,
      ]);
    } finally {
      tree.delete();
    }
  }
});

test('keeps nested primary constructors attached to their class header', () => {
  for (const modifier of ['', 'private ', '@Ann ']) {
    const member = `class Nested ${modifier}constructor(val x: Int) { companion object {} }`;
    const tree = parser.parse(`class Outer { ${member} }`)!;
    try {
      expect(tree.rootNode.hasError, member).toBe(false);
      expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([member, 'companion object {}']);
      expect(tree.rootNode.descendantsOfType('primary_constructor')).toHaveLength(1);
      expect(tree.rootNode.descendantsOfType('secondary_constructor')).toHaveLength(0);
    } finally {
      tree.delete();
    }
  }
});

test('retains contextual companion object names and bodies', () => {
  for (const name of ['init', 'constructor', 'companion']) {
    for (const body of ['', ' {}']) {
      const member = `companion object ${name}${body}`;
      const tree = parser.parse(`class C { fun f() {} ${member} }`)!;
      try {
        expect(tree.rootNode.hasError, member).toBe(false);
        expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(['fun f() {}', member]);
        expect(tree.rootNode.descendantsOfType('companion_object')[0]?.childForFieldName('name')?.text).toBe(name);
      } finally {
        tree.delete();
      }
    }
  }
});

test('keeps annotated same-line members separate across edits', () => {
  const first = 'fun first() {}';
  for (const second of [
    '@Ann fun second() {}',
    '@Ann fun (Int).second() {}',
    '@Ann fun (Int)?.second() {}',
    '@Ann fun (Int) ? /* bound */ .second() {}',
    '@Ann fun ((Int) -> Int)?.second() {}',
    '@Ann fun ((Int) -> Int).second() {}',
    '@Ann fun List<() -> Unit>.second() {}',
    '@Ann fun `name(with_paren`() {}',
    '@Ann(")") private fun second() {}',
    '@pkg.Ann @Other fun second() {}',
    '@[First Second("]")] fun second() {}',
    '@Ann /* outer /* inner */ */ constructor() {}',
    '@Ann companion object {}',
    '@Ann class Nested {}',
  ]) {
    const source = `class C { ${first} ${second} }`;
    const tree = parser.parse(source)!;
    let edited: ReturnType<Parser['parse']> | undefined;
    let fresh: ReturnType<Parser['parse']> | undefined;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      expect(
        query.captures(tree.rootNode).map(({ node }) => node.text),
        source
      ).toEqual([first, second]);
      const start = source.indexOf(second);
      const insertion = '@Added ';
      const changed = source.slice(0, start) + insertion + source.slice(start);
      tree.edit(
        new Edit({
          startIndex: start,
          oldEndIndex: start,
          newEndIndex: start + insertion.length,
          startPosition: { row: 0, column: start },
          oldEndPosition: { row: 0, column: start },
          newEndPosition: { row: 0, column: start + insertion.length },
        })
      );
      edited = parser.parse(changed, tree);
      fresh = parser.parse(changed);
      for (const result of [edited!, fresh!]) {
        expect(result.rootNode.hasError, changed).toBe(false);
        expect(query.captures(result.rootNode).map(({ node }) => [node.text, node.startIndex, node.endIndex])).toEqual([
          [first, source.indexOf(first), source.indexOf(first) + first.length],
          [insertion + second, start, start + insertion.length + second.length],
        ]);
      }
      expect(edited!.rootNode.toString()).toBe(fresh!.rootNode.toString());
    } finally {
      fresh?.delete();
      edited?.delete();
      tree.delete();
    }
  }
});

test('keeps annotated function literals inside member expressions', () => {
  for (const expression of [
    'call() @Ann {}',
    'call() @Ann(")") { value() }',
    '1 use @Ann fun(x: Int) = x',
    '1 private @Ann fun(x: Int) = x',
    '1 private @Ann fun Int.(x: Int) = x',
    '1 private @Ann fun List<() -> Unit>.() {}',
    '1 private @Ann fun List<() -> (Pair<Int, Int>)>.() {}',
    '1 private @Ann fun @TypeAnn(")") List<() -> Unit>.() {}',
  ]) {
    const member = `fun f() = ${expression}`;
    const tree = parser.parse(`class C { ${member} }`)!;
    try {
      expect(tree.rootNode.hasError, member).toBe(false);
      expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([member]);
      expect(
        tree.rootNode.descendantsOfType(['annotated_lambda', 'annotated_expression']).map((node) => node.text)
      ).toEqual([expression.slice(expression.indexOf('@'))]);
    } finally {
      tree.delete();
    }
  }
});

test('retains immediate super labels before same-line members', () => {
  for (const target of ['super@C', 'super<A>@C']) {
    const first = `fun f() = ${target}.foo()`;
    const second = 'fun g() {}';
    const tree = parser.parse(`class C : A { ${first} ${second} }`)!;
    try {
      expect(tree.rootNode.hasError, first).toBe(false);
      expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([first, second]);
      expect(tree.rootNode.descendantsOfType('super_expression').map((node) => node.text)).toEqual([target]);
    } finally {
      tree.delete();
    }
  }
});

test('recovers from unfinished type arguments in annotated member headers', () => {
  for (const header of ['<', '<T', '<T ', '<List<', '<T /* unfinished', '<List<() -> Unit>']) {
    const source = `class C { fun f() {} @Ann fun ${header}`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(true);
      expect(tree.rootNode.endIndex, source).toBe(source.length);
    } finally {
      tree.delete();
    }
  }
});
