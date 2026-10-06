import { expect, test } from 'vitest';
import path from 'node:path';
import { Edit, Language, Parser, Query, type Point } from '@willbooster/web-tree-sitter';

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
  try {
    for (const [source, separatedNode] of [
      ['class Foo;\n@A constructor()', 'primary_constructor'],
      ['class Foo { val x = 1;\n@A get() = field }', 'getter'],
    ] as const) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.descendantsOfType('class_declaration')).toHaveLength(1);
        expect(tree.rootNode.descendantsOfType(separatedNode)).toHaveLength(0);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
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
      for (const annotation of [
        '@A',
        '@A /* comment */\n@B',
        '@`for`',
        '@Foo.`for`',
        '@A.`B`',
        '@A\n@`B`',
        '@A("' + 'x'.repeat(3000) + '")',
        '@A("' + 'x'.repeat(100_000) + '")',
        '@A\n' + '// explanation note\n'.repeat(200),
      ]) {
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
      '@file:[JvmName("AnnotatedInfix") Suppress("unused")]',
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

test('keeps property declarations around long annotation prefixes', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(property_declaration (variable_declaration (identifier) @name))');
  try {
    const repeated = Array.from(
      { length: 20 },
      (_, index) =>
        `@LongMark("Use the replacement API member ${index} instead, which keeps the migration guide links and notes current.")`
    ).join('\n');
    const longName = 'A'.repeat(3000);
    for (const [declaration, annotations] of [
      ['@Repeatable\nannotation class LongMark(val reason: String)', repeated],
      ['', '@Suppress("unused")\n' + ('// explanation note '.repeat(6) + '\n').repeat(30)],
      [`annotation class ${longName}`, `@${longName}`],
    ]) {
      const source = `${declaration}\nval x = 1\n${annotations}\nval y = 2`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(['x', 'y']);
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('keeps declarations queryable before trailing use-site annotation groups', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(
    language,
    '(class_declaration name: (identifier) @class) (property_declaration (variable_declaration (identifier) @property))'
  );
  try {
    for (const [source, expected] of [
      ['class Foo\n@get:[A B]', ['Foo']],
      ['class Foo {\nval x = 1\n@get:[A B]\n}', ['Foo', 'x']],
      ['val x = 1\n@field:[A B]', ['x']],
    ] as const) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError).toBe(true);
        expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(expected);
      } finally {
        tree.delete();
      }
    }
    const source = 'val x = 1\n@field:[A B]';
    const addition = '\nval y = 2';
    const tree = parser.parse(source)!;
    let completed: ReturnType<Parser['parse']> | undefined;
    let fresh: ReturnType<Parser['parse']> | undefined;
    try {
      tree.edit(
        new Edit({
          startIndex: source.length,
          oldEndIndex: source.length,
          newEndIndex: source.length + addition.length,
          startPosition: { row: 1, column: 12 },
          oldEndPosition: { row: 1, column: 12 },
          newEndPosition: { row: 2, column: 9 },
        })
      );
      completed = parser.parse(source + addition, tree)!;
      fresh = parser.parse(source + addition)!;
      expect(completed.rootNode.toString()).toBe(fresh.rootNode.toString());
      expect(fresh.rootNode.hasError).toBe(false);
      expect(query.captures(completed.rootNode).map(({ node }) => node.text)).toEqual(['x', 'y']);
    } finally {
      tree.delete();
      completed?.delete();
      fresh?.delete();
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('keeps annotated calls on their operands across declaration edits', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const query = new Query(
      language,
      `
      (call_expression (expression) @callee (annotated_lambda (annotation)) @lambda) @call
      (call_expression (primary_expression) @primary (annotated_lambda (annotation)))
      (call_expression (value_arguments) @arguments (annotated_lambda (annotation)))
      (property_declaration (variable_declaration (identifier) @property))
    `
    );
    try {
      for (const annotation of ['@A', '@A("")', `@A("${'x'.repeat(3000)}")`]) {
        const body = '{ println() }';
        for (const [initializer, target, callee, argumentsText] of [
          ['f(1)', 'f(1)', 'f', ['(1)']],
          ['obj.f(1)', 'obj.f(1)', 'obj.f', ['(1)']],
          ['a + Runnable', 'Runnable', 'Runnable', []],
          ['a + f(1)', 'f(1)', 'f', ['(1)']],
          ['when(a) { else -> b }', 'when(a) { else -> b }', 'when(a) { else -> b }', []],
          ['try { a } finally { b }', 'try { a } finally { b }', 'try { a } finally { b }', []],
          ['if(a) { b } else { c }', 'if(a) { b } else { c }', 'if(a) { b } else { c }', []],
          ['if(a) { b }', 'if(a) { b }', 'if(a) { b }', []],
          ['-Runnable', 'Runnable', 'Runnable', []],
          ['a ?: Runnable', 'Runnable', 'Runnable', []],
          ...(annotation.includes('(')
            ? ([
                ['run { a }', 'run { a }', 'run { a }', []],
                ['if(a) run { b } else run { c }', 'run { c }', 'run { c }', []],
                ['if(a) {b} else run { c }', 'run { c }', 'run { c }', []],
              ] as const)
            : []),
        ] as const) {
          const source = `class C { val r = ${initializer}\n${annotation}\n${body}\n}`;
          const tree = parser.parse(source)!;
          let edited: ReturnType<Parser['parse']> | undefined;
          let fresh: ReturnType<Parser['parse']> | undefined;
          try {
            expect(tree.rootNode.hasError).toBe(false);
            const captures = query.captures(tree.rootNode);
            for (const name of ['callee', 'primary']) {
              expect(captures.filter((capture) => capture.name === name).map(({ node }) => node.text)).toEqual([
                callee,
              ]);
            }
            if (argumentsText.length > 0) {
              expect(captures.filter(({ name }) => name === 'arguments').map(({ node }) => node.text)).toEqual(
                argumentsText
              );
            }
            const call = captures.find(({ name }) => name === 'call')!.node;
            const lambda = captures.find(({ name }) => name === 'lambda')!.node;
            expect(call.text).toBe(`${target}\n${annotation}\n${body}`);
            expect(call.startIndex).toBe(source.indexOf(target));
            expect(lambda.text).toBe(`${annotation}\n${body}`);
            expect(lambda.startIndex).toBe(source.indexOf(annotation));
            expect(lambda.endIndex).toBe(call.endIndex);
            const replacement = 'val y = 2';
            const index = source.indexOf(body);
            tree.edit(
              new Edit({
                startIndex: index,
                oldEndIndex: index + body.length,
                newEndIndex: index + replacement.length,
                startPosition: { row: 2, column: 0 },
                oldEndPosition: { row: 2, column: body.length },
                newEndPosition: { row: 2, column: replacement.length },
              })
            );
            const changedSource = source.slice(0, index) + replacement + source.slice(index + body.length);
            edited = parser.parse(changedSource, tree)!;
            fresh = parser.parse(changedSource)!;
            expect(edited.rootNode.hasError).toBe(false);
            expect(edited.rootNode.toString()).toBe(fresh.rootNode.toString());
            const captureValues = (
              root: typeof tree.rootNode
            ): { name: string; text: string; start: number; end: number }[] =>
              query.captures(root).map(({ name, node }) => ({
                name,
                text: node.text,
                start: node.startIndex,
                end: node.endIndex,
              }));
            expect(captureValues(edited.rootNode)).toEqual(captureValues(fresh.rootNode));
            expect(
              query
                .captures(edited.rootNode)
                .filter(({ name }) => name === 'property')
                .map(({ node }) => node.text)
            ).toEqual(['r', 'y']);
          } finally {
            tree.delete();
            edited?.delete();
            fresh?.delete();
          }
        }
      }
    } finally {
      query.delete();
    }
  } finally {
    parser.delete();
  }
});

test('retains annotation and accessor ranges beyond recovery lookahead', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const query = new Query(
      language,
      '(getter (modifiers) @modifiers) @accessor (setter (modifiers) @modifiers) @accessor'
    );
    try {
      const annotation = `@A("${'x'.repeat(3000)}")`;
      for (const [initializer, accessor] of [
        ['1', 'get() = field'],
        ['foo()', 'get() = field'],
        ['a + b', 'get() = field'],
        ['foo()', 'private get() = field'],
        ['1', 'set(value) { field = value }'],
        ['foo()', 'set(value) { field = value }'],
      ] as const) {
        const source = `annotation class A(val text: String)\nclass C { var x = ${initializer}\n${annotation}\n${accessor}\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          const captures = query.captures(tree.rootNode);
          const modifiers = captures.find(({ name }) => name === 'modifiers')!.node;
          const node = captures.find(({ name }) => name === 'accessor')!.node;
          expect(modifiers.text).toBe(`${annotation}${accessor.startsWith('private ') ? '\nprivate' : ''}`);
          expect(modifiers.startIndex).toBe(source.indexOf(annotation));
          expect(node.text).toBe(`${annotation}\n${accessor}`);
          expect(node.startIndex).toBe(modifiers.startIndex);
          expect(node.endIndex).toBe(source.indexOf(accessor) + accessor.length);
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

test('keeps long annotated members after an expression getter', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const query = new Query(
      language,
      '(getter (function_body) @body) (secondary_constructor (modifiers) @modifiers) @constructor (function_declaration name: (identifier) @function) (property_declaration (variable_declaration (identifier) @property))'
    );
    try {
      const annotation = `@A("${'x'.repeat(3000)}")`;
      for (const [declaration, expected] of [
        ['constructor(x: Int): this()', ['value']],
        ['fun z() = 1', ['value', 'z']],
        ['val y = 2', ['value', 'y']],
      ] as const) {
        const source = `class C() { var value = 1\nget() = field\n${annotation}\n${declaration}\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          const captures = query.captures(tree.rootNode);
          expect(captures.filter(({ name }) => name === 'body').map(({ node }) => node.text)).toEqual(['= field']);
          expect(
            captures.filter(({ name }) => name === 'function' || name === 'property').map(({ node }) => node.text)
          ).toEqual(expected);
          const member = tree.rootNode
            .descendantsOfType(['secondary_constructor', 'function_declaration', 'property_declaration'])
            .at(-1)!;
          expect(member.text).toBe(`${annotation}\n${declaration}`);
          expect(member.startIndex).toBe(source.indexOf(annotation));
          expect(member.endIndex).toBe(source.indexOf(declaration) + declaration.length);
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

test('keeps annotated local calls, anonymous functions and return or loop operands distinct', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const query = new Query(
      language,
      '(call_expression (expression) @callee) (getter) @accessor (setter) @accessor (annotated_expression) @annotated (return_expression) @return (anonymous_function) @anonymous'
    );
    try {
      for (const annotation of ['@A', `@A("${'x'.repeat(3000)}")`]) {
        const source = `fun f() { val x=foo()\n${annotation} set(x) {} }`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          const captures = query.captures(tree.rootNode);
          expect(captures.filter(({ name }) => name === 'accessor')).toHaveLength(0);
          expect(captures.filter(({ name }) => name === 'callee').map(({ node }) => node.text)).toEqual(['foo', 'set']);
          expect(captures.filter(({ name }) => name === 'annotated').map(({ node }) => node.text)).toEqual([
            `${annotation} set(x) {}`,
          ]);
        } finally {
          tree.delete();
        }
      }
      for (const statement of ['return', 'return@f']) {
        const source = `fun f() { ${statement}\n@A { x } }`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          const captures = query.captures(tree.rootNode);
          expect(captures.filter(({ name }) => name === 'return').map(({ node }) => node.text)).toEqual([statement]);
          expect(captures.filter(({ name }) => name === 'annotated').map(({ node }) => node.text)).toEqual([
            '@A { x }',
          ]);
        } finally {
          tree.delete();
        }
      }
      for (const prefix of ['return', 'return@f', 'while (a)', 'for (i in l)']) {
        const tree = parser.parse(`fun f() { ${prefix} @A x }`)!;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          expect(
            query
              .captures(tree.rootNode)
              .filter(({ name }) => name === 'annotated')
              .map(({ node }) => node.text)
          ).toEqual(['@A x']);
        } finally {
          tree.delete();
        }
      }
      const anonymous = 'fun @A suspend (() -> Unit)?.() = 1';
      const source = `val x=1\n@A private constructor\n${anonymous}`;
      const tree = parser.parse(source)!;
      let edited: ReturnType<Parser['parse']> | undefined;
      let fresh: ReturnType<Parser['parse']> | undefined;
      try {
        const node = query.captures(tree.rootNode).find(({ name }) => name === 'anonymous')!.node;
        expect(node.text).toBe(anonymous);
        expect(node.startIndex).toBe(source.indexOf('fun'));
        expect(node.endIndex).toBe(source.length);
        const index = source.lastIndexOf('.()') + 1;
        const point = { row: 2, column: index - source.lastIndexOf('\n', index) - 1 };
        tree.edit(
          new Edit({
            startIndex: index,
            oldEndIndex: index,
            newEndIndex: index + 1,
            startPosition: point,
            oldEndPosition: point,
            newEndPosition: { row: point.row, column: point.column + 1 },
          })
        );
        const changed = source.slice(0, index) + 'f' + source.slice(index);
        edited = parser.parse(changed, tree)!;
        fresh = parser.parse(changed)!;
        expect(edited.rootNode.toString()).toBe(fresh.rootNode.toString());
        const name = edited.rootNode.descendantsOfType('function_declaration').at(-1)!.childForFieldName('name')!;
        expect(name.text).toBe('f');
        expect(name.startIndex).toBe(index);
        expect(edited.rootNode.descendantsOfType('anonymous_function')).toHaveLength(0);
      } finally {
        tree.delete();
        edited?.delete();
        fresh?.delete();
      }
      for (const declaration of [
        'suspend fun z() = 3',
        'private fun z() = 3',
        'fun suspend() = 3',
        'val z = 3',
        'class Z',
      ]) {
        const source = `val x=1\n@A private constructor\n${declaration}`;
        const tree = parser.parse(source)!;
        try {
          const nodes = tree.rootNode.descendantsOfType([
            'function_declaration',
            'property_declaration',
            'class_declaration',
          ]);
          const node = nodes.at(-1)!;
          const name =
            node.childForFieldName('name') ?? node.descendantsOfType('variable_declaration')[0]?.namedChildren[0];
          expect(name!.text).toBe(
            declaration === 'class Z' ? 'Z' : declaration === 'fun suspend() = 3' ? 'suspend' : 'z'
          );
          expect(name!.startIndex).toBe(source.lastIndexOf(name!.text));
          if (declaration.includes('fun'))
            expect(node.descendantsOfType('function_body').map((body) => body.text)).toEqual(['= 3']);
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

test('keeps following named functions with annotated receivers and context modifiers queryable', () => {
  const parser = new Parser().setLanguage(language);
  let query: Query | undefined;
  try {
    const activeQuery = new Query(language, '(function_declaration name: (identifier) @name (function_body) @body)');
    query = activeQuery;
    for (const header of [
      'fun @A T.f()',
      'fun @A(1) T.f()',
      'fun <R> @A T.f()',
      'fun (@A T)?.f()',
      'fun @A (T)?.f()',
      'fun suspend @A (() -> Unit)?.f()',
      'fun (() -> Unit)?.f()',
      'fun (Int)?.f()',
      'context(t:T) fun f()',
      'context /* comment */ (t:T) private fun @A T.f()',
    ]) {
      const source = `val x=1\n@A private constructor\n${header} = 1`;
      const tree = parser.parse(source)!;
      let edited: ReturnType<Parser['parse']> | undefined;
      let fresh: ReturnType<Parser['parse']> | undefined;
      try {
        const captures = (
          tree: NonNullable<ReturnType<Parser['parse']>>
        ): { name: string; text: string; start: number; end: number }[] =>
          activeQuery
            .captures(tree.rootNode)
            .map(({ name, node }) => ({ name, text: node.text, start: node.startIndex, end: node.endIndex }));
        const index = source.lastIndexOf('f(');
        const point = { row: 2, column: index - source.lastIndexOf('\n', index) - 1 };
        expect(captures(tree)).toEqual([
          { name: 'name', text: 'f', start: index, end: index + 1 },
          { name: 'body', text: '= 1', start: source.length - 3, end: source.length },
        ]);
        tree.edit(
          new Edit({
            startIndex: index,
            oldEndIndex: index + 1,
            newEndIndex: index + 7,
            startPosition: point,
            oldEndPosition: { ...point, column: point.column + 1 },
            newEndPosition: { ...point, column: point.column + 7 },
          })
        );
        const changed = source.slice(0, index) + 'renamed' + source.slice(index + 1);
        edited = parser.parse(changed, tree)!;
        fresh = parser.parse(changed)!;
        expect(edited.rootNode.toString()).toBe(fresh.rootNode.toString());
        expect(captures(edited)).toEqual(captures(fresh));
        expect(captures(edited)).toEqual([
          { name: 'name', text: 'renamed', start: index, end: index + 7 },
          { name: 'body', text: '= 1', start: changed.length - 3, end: changed.length },
        ]);
      } finally {
        tree.delete();
        edited?.delete();
        fresh?.delete();
      }
    }
  } finally {
    query?.delete();
    parser.delete();
  }
});

test('keeps file annotation ranges before blank lines and later annotations', () => {
  const parser = new Parser().setLanguage(language);
  let query: Query | undefined;
  try {
    query = new Query(language, '(file_annotation) @file (function_declaration) @function');
    const first = '@file:Suppress("unused")';
    const second = '@file:JvmName("Boundary")';
    for (const [trivia, firstText] of [
      ['', first],
      ['\n', first],
      ['// comment\n\n', first + '\n// comment'],
    ] as const) {
      const source = `${first}\n${trivia}${second}\nfun f() {}`;
      const tree = parser.parse(source)!;
      let edited: ReturnType<Parser['parse']> | undefined;
      let fresh: ReturnType<Parser['parse']> | undefined;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        const captures = query.captures(tree.rootNode);
        expect(
          captures.filter(({ name }) => name === 'file').map(({ node }) => [node.text, node.startIndex, node.endIndex])
        ).toEqual([
          [firstText, 0, firstText.length],
          [second, source.indexOf(second), source.indexOf(second) + second.length],
        ]);
        expect(captures.filter(({ name }) => name === 'function').map(({ node }) => node.text)).toEqual(['fun f() {}']);
        const index = source.indexOf('JvmName') + 'JvmName'.length;
        const row = source.slice(0, index).split('\n').length - 1;
        const column = index - source.lastIndexOf('\n', index) - 1;
        tree.edit(
          new Edit({
            startIndex: index,
            oldEndIndex: index,
            newEndIndex: index + 1,
            startPosition: { row, column },
            oldEndPosition: { row, column },
            newEndPosition: { row, column: column + 1 },
          })
        );
        const changed = source.slice(0, index) + 'X' + source.slice(index);
        edited = parser.parse(changed, tree)!;
        fresh = parser.parse(changed)!;
        expect(edited.rootNode.hasError).toBe(false);
        expect(fresh.rootNode.hasError).toBe(false);
        expect(edited.rootNode.toString()).toBe(fresh.rootNode.toString());
        const snapshot = (node: NonNullable<ReturnType<Parser['parse']>>): (string | number | Point)[][] =>
          query!
            .captures(node.rootNode)
            .map(({ name, node }) => [
              name,
              node.text,
              node.startIndex,
              node.endIndex,
              node.startPosition,
              node.endPosition,
            ]);
        expect(snapshot(edited)).toEqual(snapshot(fresh));
        expect(query.captures(edited.rootNode).find(({ name }) => name === 'file')!.node.text).toBe(firstText);
      } finally {
        tree.delete();
        edited?.delete();
        fresh?.delete();
      }
    }
  } finally {
    query?.delete();
    parser.delete();
  }
});

test('keeps spaced annotation arguments before ordinary calls', () => {
  const parser = new Parser().setLanguage(language);
  let query: Query | undefined;
  try {
    query = new Query(
      language,
      '(annotation (constructor_invocation (value_arguments) @annotationArguments)) (call_expression) @call (infix_expression) @infix'
    );
    for (const annotation of [
      '@Suppress ("unused")',
      '@Suppress\n("unused")',
      '@Suppress /* comment */ ("unused")',
      `@Suppress ("${'x'.repeat(3000)}")`,
    ]) {
      const source = `fun consume(x: Int) {}\nfun main() { val x=1\n${annotation} consume(2) }`;
      const tree = parser.parse(source)!;
      let edited: ReturnType<Parser['parse']> | undefined;
      let fresh: ReturnType<Parser['parse']> | undefined;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        const captures = query.captures(tree.rootNode);
        expect(captures.filter(({ name }) => name === 'annotationArguments').map(({ node }) => node.text)).toEqual([
          annotation.slice(annotation.indexOf('(')),
        ]);
        expect(
          captures.filter(({ name }) => name === 'call').map(({ node }) => [node.text, node.startIndex, node.endIndex])
        ).toEqual([['consume(2)', source.lastIndexOf('consume'), source.lastIndexOf('consume') + 'consume(2)'.length]]);
        expect(captures.filter(({ name }) => name === 'infix')).toHaveLength(0);
        const index = source.lastIndexOf('consume') + 'consume'.length;
        const row = source.slice(0, index).split('\n').length - 1;
        const column = index - source.lastIndexOf('\n', index) - 1;
        tree.edit(
          new Edit({
            startIndex: index,
            oldEndIndex: index,
            newEndIndex: index + 5,
            startPosition: { row, column },
            oldEndPosition: { row, column },
            newEndPosition: { row, column: column + 5 },
          })
        );
        const changed = source.slice(0, index) + 'Again' + source.slice(index);
        edited = parser.parse(changed, tree)!;
        fresh = parser.parse(changed)!;
        expect(edited.rootNode.hasError).toBe(false);
        expect(fresh.rootNode.hasError).toBe(false);
        expect(edited.rootNode.toString()).toBe(fresh.rootNode.toString());
        const snapshot = (node: NonNullable<ReturnType<Parser['parse']>>): (string | number | Point)[][] =>
          query!
            .captures(node.rootNode)
            .map(({ name, node }) => [
              name,
              node.text,
              node.startIndex,
              node.endIndex,
              node.startPosition,
              node.endPosition,
            ]);
        expect(snapshot(edited)).toEqual(snapshot(fresh));
        expect(
          query
            .captures(edited.rootNode)
            .filter(({ name }) => name === 'call')
            .map(({ node }) => node.text)
        ).toEqual(['consumeAgain(2)']);
      } finally {
        tree.delete();
        edited?.delete();
        fresh?.delete();
      }
    }
  } finally {
    query?.delete();
    parser.delete();
  }
});

test('keeps long declaration annotations after completed delegated calls', () => {
  const parser = new Parser().setLanguage(language);
  let query: Query | undefined;
  try {
    query = new Query(
      language,
      '(function_declaration name: (identifier) @name) @function (property_declaration) @property (call_expression) @call'
    );
    for (const context of ['object O', 'class C', '']) {
      for (const annotation of ['@A("y")', `@A("${'y'.repeat(2100)}")`, `@A /*${'x'.repeat(3000)}*/ ("y")`]) {
        const property = 'val extractor: Int by lazy { 1 }';
        const source = `${context ? context + ' {\n' : ''}${property}\n${annotation}\nfun init() {}${context ? '\n}' : ''}`;
        const tree = parser.parse(source)!;
        let edited: ReturnType<Parser['parse']> | undefined;
        let fresh: ReturnType<Parser['parse']> | undefined;
        try {
          expect(tree.rootNode.hasError).toBe(false);
          const captures = query.captures(tree.rootNode);
          expect(captures.filter(({ name }) => name === 'name').map(({ node }) => node.text)).toEqual(['init']);
          expect(captures.filter(({ name }) => name === 'function').map(({ node }) => node.text)).toEqual([
            `${annotation}\nfun init() {}`,
          ]);
          expect(
            captures
              .filter(({ name }) => name === 'property')
              .map(({ node }) => [node.text, node.startIndex, node.endIndex])
          ).toEqual([[property, source.indexOf(property), source.indexOf(property) + property.length]]);
          expect(captures.filter(({ name }) => name === 'call').map(({ node }) => node.text)).toEqual(['lazy { 1 }']);
          const index = source.lastIndexOf('init');
          const row = source.slice(0, index).split('\n').length - 1;
          const column = index - source.lastIndexOf('\n', index) - 1;
          tree.edit(
            new Edit({
              startIndex: index,
              oldEndIndex: index + 4,
              newEndIndex: index + 7,
              startPosition: { row, column },
              oldEndPosition: { row, column: column + 4 },
              newEndPosition: { row, column: column + 7 },
            })
          );
          const changed = source.slice(0, index) + 'renamed' + source.slice(index + 4);
          edited = parser.parse(changed, tree)!;
          fresh = parser.parse(changed)!;
          expect(edited.rootNode.hasError).toBe(false);
          expect(fresh.rootNode.hasError).toBe(false);
          expect(edited.rootNode.toString()).toBe(fresh.rootNode.toString());
          const snapshot = (node: NonNullable<ReturnType<Parser['parse']>>): (string | number | Point)[][] =>
            query!
              .captures(node.rootNode)
              .map(({ name, node }) => [
                name,
                node.text,
                node.startIndex,
                node.endIndex,
                node.startPosition,
                node.endPosition,
              ]);
          expect(snapshot(edited)).toEqual(snapshot(fresh));
          expect(
            query
              .captures(edited.rootNode)
              .filter(({ name }) => name === 'name')
              .map(({ node }) => node.text)
          ).toEqual(['renamed']);
        } finally {
          tree.delete();
          edited?.delete();
          fresh?.delete();
        }
      }
    }
  } finally {
    query?.delete();
    parser.delete();
  }
});

test('keeps when-entry ranges before parenthesized entries and class-constructor ranges after newlines', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(when_entry) @entry (primary_constructor) @constructor');
  try {
    for (const newline of ['\n', '\r\n']) {
      for (const blankLines of [0, 2, 8]) {
        for (const body of ['a', '{ a }']) {
          for (const next of ['(b)', '@A b']) {
            const first = `1 -> ${body}`;
            const source = `fun f() {${newline}  when (x) {${newline}    ${first}${newline.repeat(blankLines + 1)}    ${next} -> c${newline}  }${newline}}`;
            const tree = parser.parse(source)!;
            try {
              expect(tree.rootNode.hasError, source).toBe(false);
              const entry = query.captures(tree.rootNode).find(({ name }) => name === 'entry')!.node;
              expect([entry.text, entry.startIndex, entry.endIndex], source).toEqual([
                first,
                source.indexOf(first),
                source.indexOf(first) + first.length,
              ]);
              expect(entry.endPosition).toEqual({ row: 2, column: 4 + first.length });
              const index = entry.endIndex;
              const insertion = newline.repeat(2);
              const changed = source.slice(0, index) + insertion + source.slice(index);
              tree.edit(
                new Edit({
                  startIndex: index,
                  oldEndIndex: index,
                  newEndIndex: index + insertion.length,
                  startPosition: entry.endPosition,
                  oldEndPosition: entry.endPosition,
                  newEndPosition: { row: 4, column: 0 },
                })
              );
              const incremental = parser.parse(changed, tree)!;
              const fresh = parser.parse(changed)!;
              try {
                expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
                const snapshot = (current: NonNullable<ReturnType<Parser['parse']>>): unknown[][] =>
                  query
                    .captures(current.rootNode)
                    .map(({ name, node }) => [
                      name,
                      node.text,
                      node.startIndex,
                      node.endIndex,
                      node.startPosition,
                      node.endPosition,
                    ]);
                expect(snapshot(incremental)).toEqual(snapshot(fresh));
                expect(query.captures(incremental.rootNode)[0]!.node.text).toBe(first);
              } finally {
                incremental.delete();
                fresh.delete();
              }
            } finally {
              tree.delete();
            }
          }
        }
        const parameters = '(val x: Int)';
        const source = `class A${newline.repeat(blankLines + 1)}  ${parameters}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const constructor = query.captures(tree.rootNode).find(({ name }) => name === 'constructor')!.node;
          expect([constructor.text, constructor.startIndex, constructor.endIndex]).toEqual([
            parameters,
            source.indexOf(parameters),
            source.length,
          ]);
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});
