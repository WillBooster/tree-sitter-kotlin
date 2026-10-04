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
  'class Foo\n@A private @B constructor',
  'class Foo\n@pkg.A<List<Int>> private /* comment */ @B(1) constructor',
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
  const queries = new Map<string, Query>();
  try {
    for (const annotation of [
      '@A',
      '@Suppress("x")',
      '@pkg.A<List<Int>>',
      '@A\n("x")',
      '@A(',
      '@A<',
      '@A("unfinished',
      '@A private @B',
      '@A internal @B(1)',
      '@pkg.A<List<Int>> private /* comment */ @B',
    ]) {
      for (const [prefix, suffix, node, expected] of [
        ['class Foo', '', 'class_declaration', ['class Foo']],
        ['val x = 1', '', 'property_declaration', ['val x = 1']],
        ['class Foo {\n val x = 1', '\n}', 'property_declaration', ['val x = 1']],
        ['class Foo {\n val x = 1\n val y = 2', '\n}', 'property_declaration', ['val x = 1', 'val y = 2']],
      ] as const) {
        const source = `${prefix}\n${annotation}${suffix}`;
        let query = queries.get(node);
        if (!query) {
          query = new Query(language, `(${node}) @declaration`);
          queries.set(node, query);
        }
        const tree = parser.parse(source)!;
        try {
          expect(
            query.captures(tree.rootNode).map(({ node }) => node.text),
            source
          ).toEqual(expected);
        } finally {
          tree.delete();
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
    for (const query of queries.values()) query.delete();
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

test('keeps annotated trailing lambdas in property initializer queries', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const query = new Query(
      language,
      '(property_declaration (expression) @initializer) (call_expression (annotated_lambda) @lambda) @call'
    );
    try {
      for (const annotation of ['@A', '@A /* comment */\n@B', '@A("' + 'x'.repeat(3000) + '")']) {
        const initializer = `Runnable\n${annotation}\n{ println() }`;
        for (const [prefix, suffix] of [
          ['val r = ', ''],
          ['fun f() { val r = ', ' }'],
          ['class C { val r = ', ' }'],
        ]) {
          const source = prefix + initializer + suffix;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            expect(query.captures(tree.rootNode).map(({ name, node }) => ({ name, text: node.text }))).toEqual([
              { name: 'initializer', text: initializer },
              { name: 'call', text: initializer },
              { name: 'lambda', text: `${annotation}\n{ println() }` },
            ]);
          } finally {
            tree.delete();
          }
        }
      }
      for (const source of ['foo()\n@A\n{ bar() }', 'class Foo\n@A\n{}']) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.namedChildCount).toBe(2);
          expect(query.captures(tree.rootNode)).toHaveLength(0);
        } finally {
          tree.delete();
        }
      }
      const source = 'val r = Runnable\n@A';
      const addition = '\n{ println() }';
      const tree = parser.parse(source)!;
      let completed: ReturnType<Parser['parse']> | undefined;
      let fresh: ReturnType<Parser['parse']> | undefined;
      try {
        const point = { row: 1, column: 2 };
        tree.edit(
          new Edit({
            startIndex: source.length,
            oldEndIndex: source.length,
            newEndIndex: source.length + addition.length,
            startPosition: point,
            oldEndPosition: point,
            newEndPosition: { row: 2, column: 13 },
          })
        );
        completed = parser.parse(source + addition, tree)!;
        fresh = parser.parse(source + addition)!;
        expect(completed.rootNode.toString()).toBe(fresh.rootNode.toString());
        expect(fresh.rootNode.hasError).toBe(false);
        expect(query.captures(completed.rootNode).map(({ name, node }) => ({ name, text: node.text }))).toEqual([
          { name: 'initializer', text: 'Runnable\n@A\n{ println() }' },
          { name: 'call', text: 'Runnable\n@A\n{ println() }' },
          { name: 'lambda', text: '@A\n{ println() }' },
        ]);
      } finally {
        tree.delete();
        completed?.delete();
        fresh?.delete();
      }
    } finally {
      query.delete();
    }
  } finally {
    parser.delete();
  }
});

test('retains constructor and getter annotations interleaved with modifiers', () => {
  const source = `@Target(AnnotationTarget.CONSTRUCTOR, AnnotationTarget.PROPERTY_GETTER)
annotation class A
@Target(AnnotationTarget.CONSTRUCTOR, AnnotationTarget.PROPERTY_GETTER)
annotation class B(val value: Int)
class Foo
@A private @B(1) constructor()
class Holder {
 val value: Int
 @A public @B(1) get() = 1
}
`;
  const parser = new Parser().setLanguage(language);
  let tree: ReturnType<Parser['parse']> | undefined;
  let query: Query | undefined;
  try {
    tree = parser.parse(source)!;
    expect(tree.rootNode.hasError).toBe(false);
    query = new Query(language, '(primary_constructor) @constructor (getter) @getter');
    expect(
      query
        .captures(tree.rootNode)
        .filter(({ node }) => node.text.startsWith('@A'))
        .map(({ name, node }) => ({ name, text: node.text }))
    ).toEqual([
      { name: 'constructor', text: '@A private @B(1) constructor()' },
      { name: 'getter', text: '@A public @B(1) get() = 1' },
    ]);
  } finally {
    query?.delete();
    tree?.delete();
    parser.delete();
  }
});

test('keeps a following named function after an unfinished annotated constructor prefix', () => {
  const source = 'val x = 1\n@A private constructor\n\nfun z() = 3';
  const validInfixSource = `@file:[JvmName("AnnotatedInfix") Suppress("unused")]
@Target(AnnotationTarget.EXPRESSION)
@Retention(AnnotationRetention.SOURCE)
annotation class A
class C {
 infix fun constructor(f: (Int) -> Int): Int = f(1)
}
fun f(): Int {
 val private = C()
 return (@A private constructor fun(x: Int): Int = x)
}
`;
  const parser = new Parser().setLanguage(language);
  let tree: ReturnType<Parser['parse']> | undefined;
  let completed: ReturnType<Parser['parse']> | undefined;
  let fresh: ReturnType<Parser['parse']> | undefined;
  let validTree: ReturnType<Parser['parse']> | undefined;
  let query: Query | undefined;
  try {
    query = new Query(
      language,
      '(property_declaration (variable_declaration (identifier) @property)) (function_declaration name: (identifier) @function (function_body) @body) (anonymous_function) @anonymous'
    );
    tree = parser.parse(source)!;
    const capture = (
      tree: NonNullable<ReturnType<Parser['parse']>>
    ): { name: string; text: string; start: number; end: number }[] =>
      query!
        .captures(tree.rootNode)
        .map(({ name, node }) => ({ name, text: node.text, start: node.startIndex, end: node.endIndex }));
    expect(tree.rootNode.hasError).toBe(true);
    expect(capture(tree)).toEqual([
      { name: 'property', text: 'x', start: 4, end: 5 },
      { name: 'function', text: 'z', start: 38, end: 39 },
      { name: 'body', text: '= 3', start: 42, end: 45 },
    ]);
    tree.edit(
      new Edit({
        startIndex: 39,
        oldEndIndex: 39,
        newEndIndex: 40,
        startPosition: { row: 3, column: 5 },
        oldEndPosition: { row: 3, column: 5 },
        newEndPosition: { row: 3, column: 6 },
      })
    );
    const editedSource = source.slice(0, 39) + 'z' + source.slice(39);
    completed = parser.parse(editedSource, tree)!;
    fresh = parser.parse(editedSource)!;
    expect(completed.rootNode.toString()).toBe(fresh.rootNode.toString());
    expect(capture(completed)).toEqual([
      { name: 'property', text: 'x', start: 4, end: 5 },
      { name: 'function', text: 'zz', start: 38, end: 40 },
      { name: 'body', text: '= 3', start: 43, end: 46 },
    ]);
    validTree = parser.parse(validInfixSource)!;
    expect(validTree.rootNode.hasError).toBe(false);
    expect(validTree.rootNode.descendantsOfType('file_annotation').map((node) => node.text)).toEqual([
      '@file:[JvmName("AnnotatedInfix") Suppress("unused")]\n',
    ]);
    expect(
      query
        .captures(validTree.rootNode)
        .filter(({ name }) => name === 'anonymous')
        .map(({ node }) => node.text)
    ).toEqual(['fun(x: Int): Int = x']);
  } finally {
    query?.delete();
    tree?.delete();
    completed?.delete();
    fresh?.delete();
    validTree?.delete();
    parser.delete();
  }
});
