import { expect, test } from 'vitest';
import path from 'node:path';
import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));

const incompleteHeaders = [
  'class Foo\n@A/*c*/\nconstructor',
  'class Foo\n@A(run { class Local; 1 }) constructor',
  'class Foo\n@A\ninternal constructor',
  'class Foo\n@A private constructor\nval x = 1',
  'class Foo\n@A private /* comment */ constructor',
  'class Foo\n@A private // comment\n constructor',
  'class Foo\n@A(1)\ninternal constructor',
  'class Foo\n@A(run { class Local; 1 }) private constructor',
  'class Foo\n@Foo<Int> internal constructor',
  'class Foo\n@pkg.A private constructor',
  'class Foo\n@`A name` private constructor',
  'class Foo\n@A\n(1)\ninternal constructor',
  'class Foo\n@A\n(run { class Local; 1 }) private constructor',
];

test('keeps annotated class headers queryable while completing their constructors', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, '(class_declaration name: (identifier) @name)');
  for (const source of incompleteHeaders) {
    const tree = parser.parse(source)!;
    expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toContain('Foo');
    const index = source.indexOf('constructor') + 'constructor'.length;
    const prefix = source.slice(0, index).split('\n');
    const point = { row: prefix.length - 1, column: prefix.at(-1)!.length };
    tree.edit(
      new Edit({
        startIndex: index,
        oldEndIndex: index,
        newEndIndex: index + 2,
        startPosition: point,
        oldEndPosition: point,
        newEndPosition: { row: point.row, column: point.column + 2 },
      })
    );
    const completedSource = `${source.slice(0, index)}()${source.slice(index)}`;
    const completed = parser.parse(completedSource, tree)!;
    const fresh = parser.parse(completedSource)!;
    expect(completed.rootNode.toString()).toBe(fresh.rootNode.toString());
    expect(fresh.rootNode.hasError).toBe(false);
    expect(fresh.rootNode.descendantsOfType('primary_constructor')).toHaveLength(1);
    tree.delete();
    completed.delete();
    fresh.delete();
  }
  query.delete();
  parser.delete();
});

test('an explicit semicolon separates annotations from constructor and getter attachment', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  for (const source of ['class Foo;\n@A constructor()', 'class Foo { val x = 1;\n@A get() = field }']) {
    const tree = parser.parse(source)!;
    expect(tree.rootNode.descendantsOfType('class_declaration')).toHaveLength(1);
    expect(tree.rootNode.descendantsOfType('primary_constructor')).toHaveLength(0);
    expect(tree.rootNode.descendantsOfType('getter')).toHaveLength(0);
    tree.delete();
  }
  parser.delete();
});

test('parses complete annotation arguments beyond the optional recovery lookahead', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  for (const spacing of [' ', ' '.repeat(3000)]) {
    const source = `class Foo\n@A("${'class X ( ) <> '.repeat(10_000)}")${spacing}internal constructor()`;
    const tree = parser.parse(source)!;
    expect(tree.rootNode.hasError).toBe(false);
    const constructor = tree.rootNode.descendantsOfType('primary_constructor');
    expect(constructor).toHaveLength(1);
    expect(constructor[0]!.text).toBe(source.slice(source.indexOf('@A')));
    tree.delete();
  }
  parser.delete();
});

test('keeps literals and comparisons inside annotation type arguments', () => {
  const source = `
@Target(AnnotationTarget.CONSTRUCTOR)
annotation class Generic<T>
@Target(AnnotationTarget.TYPE)
annotation class TypeMark(val value: String)
@Target(AnnotationTarget.TYPE)
annotation class CharMark(val value: Char)
const val constructor = 1
@Target(AnnotationTarget.TYPE)
annotation class TypeFlag(val value: Boolean)
class Constructed
    @Generic<@TypeMark("> internal constructor") @CharMark('>') String>
    internal constructor()
class RawArgument
    @Generic<@TypeMark("""> internal constructor""") String>
    internal constructor()
class ComparedArgument
    @Generic<@TypeFlag(2 > constructor) Int>
    internal constructor()
`;
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source)!;
  expect(tree.rootNode.hasError).toBe(false);
  const query = new Query(language, '(class_declaration name: (identifier) @name (primary_constructor) @constructor)');
  expect(
    query
      .captures(tree.rootNode)
      .filter(({ name }) => name === 'name')
      .map(({ node }) => node.text)
  ).toEqual(['TypeMark', 'CharMark', 'TypeFlag', 'Constructed', 'RawArgument', 'ComparedArgument']);
  query.delete();
  tree.delete();
  parser.delete();
});

test('keeps completed declarations queryable before trailing annotations', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const annotation of [
      '@A',
      '@Suppress("x")',
      '@pkg.A<List<Int>>',
      '@A\n("x")',
      '@A(',
      '@A<',
      '@A("unfinished',
    ]) {
      for (const [prefix, suffix, node, expected] of [
        ['class Foo', '', 'class_declaration', ['class Foo']],
        ['val x = 1', '', 'property_declaration', ['val x = 1']],
        ['class Foo {\n val x = 1', '\n}', 'property_declaration', ['val x = 1']],
        ['class Foo {\n val x = 1\n val y = 2', '\n}', 'property_declaration', ['val x = 1', 'val y = 2']],
      ] as const) {
        const source = `${prefix}\n${annotation}${suffix}`;
        const query = new Query(language, `(${node}) @declaration`);
        try {
          const tree = parser.parse(source)!;
          try {
            expect(
              query.captures(tree.rootNode).map(({ node }) => node.text),
              source
            ).toEqual(expected);
          } finally {
            tree.delete();
          }
        } finally {
          query.delete();
        }
      }
    }
    for (const [source, addition, node] of [
      ['class Foo\n@A', '\nconstructor()', 'primary_constructor'],
      ['class Foo { val x = 1\n@A\n}', '\nget() = field', 'getter'],
    ] as const) {
      const tree = parser.parse(source)!;
      let completed: ReturnType<Parser['parse']> | undefined;
      let fresh: ReturnType<Parser['parse']> | undefined;
      try {
        const index = source.indexOf('@A') + '@A'.length;
        const lines = source.slice(0, index).split('\n');
        const point = { row: lines.length - 1, column: lines.at(-1)!.length };
        const addedLines = addition.split('\n');
        tree.edit(
          new Edit({
            startIndex: index,
            oldEndIndex: index,
            newEndIndex: index + addition.length,
            startPosition: point,
            oldEndPosition: point,
            newEndPosition: { row: point.row + addedLines.length - 1, column: addedLines.at(-1)!.length },
          })
        );
        const completeSource = source.slice(0, index) + addition + source.slice(index);
        completed = parser.parse(completeSource, tree)!;
        fresh = parser.parse(completeSource)!;
        expect(completed.rootNode.toString()).toBe(fresh.rootNode.toString());
        expect(fresh.rootNode.hasError).toBe(false);
        expect(fresh.rootNode.descendantsOfType(node)).toHaveLength(1);
      } finally {
        tree.delete();
        completed?.delete();
        fresh?.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('keeps spaced annotation arguments before annotated parenthesized expressions', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const query = new Query(
      language,
      '(annotation (constructor_invocation (value_arguments) @arguments)) @annotation (annotated_expression (call_expression) @call)'
    );
    try {
      for (const spacing of [' ', '\n', ' /* comment */ ', ' // comment\n']) {
        const annotation = `@Suppress${spacing}("UNUSED_EXPRESSION")`;
        const source = `class B { fun c() {} }\nfun f(b: B) {\nval x = 1\n${annotation} (b).c()\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(query.captures(tree.rootNode).map(({ name, node }) => ({ name, text: node.text }))).toEqual([
            { name: 'annotation', text: annotation },
            { name: 'arguments', text: '("UNUSED_EXPRESSION")' },
            { name: 'call', text: '(b).c()' },
          ]);
        } finally {
          tree.delete();
        }
      }
    } finally {
      query.delete();
    }
  } finally {
    parser.delete();
  }
});

test('keeps surrounding class members queryable while an annotated member is unfinished', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const query = new Query(
      language,
      '(class_body (property_declaration) @property) (class_body (function_declaration name: (identifier) @function))'
    );
    try {
      for (const annotation of ['@A', '@A(1)', '@A(', '@Inject\nlateinit', '@Deprecated("x")\nfu']) {
        const source = `class C {\nval x = 1\n${annotation}\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(
            query.captures(tree.rootNode).map(({ node }) => node.text),
            source
          ).toEqual(['val x = 1']);
        } finally {
          tree.delete();
        }
      }
      const source = `class C {\nfun a() {}\nval b = 2\nprivate val x: Int = compute()\n@Deprecated("x")\nfu\nfun z() = 3\n}`;
      const tree = parser.parse(source)!;
      try {
        expect(query.captures(tree.rootNode).map(({ name, node }) => ({ name, text: node.text }))).toEqual([
          { name: 'function', text: 'a' },
          { name: 'property', text: 'val b = 2' },
          { name: 'property', text: 'private val x: Int = compute()' },
          { name: 'function', text: 'z' },
        ]);
      } finally {
        tree.delete();
      }
    } finally {
      query.delete();
    }
  } finally {
    parser.delete();
  }
});
