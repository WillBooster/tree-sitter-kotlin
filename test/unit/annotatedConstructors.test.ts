import { expect, test } from 'vitest';
import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';

await Parser.init();
const language = await Language.load('tree-sitter-kotlin.wasm');
const snapshot = (node: NonNullable<ReturnType<Parser['parse']>>['rootNode']): unknown => [
  node.type,
  node.grammarType,
  node.isNamed,
  node.isExtra,
  node.isMissing,
  node.isError,
  node.hasError,
  node.startIndex,
  node.endIndex,
  node.startPosition,
  node.endPosition,
  node.children.map((_, i) => node.fieldNameForChild(i)),
  node.children.map(snapshot),
];

test('keeps annotated primary constructors with visibility modifiers attached to their class', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(class_declaration name: (identifier) @class (primary_constructor) @constructor)');
  try {
    for (const annotation of [
      '@Marker',
      '@Marker(1)',
      '@Marker(/*c*/1)',
      '@Deprecated("constructor")',
      '@Deprecated("$")',
      '@Deprecated("$1")',
      String.raw`@Deprecated("\$name")`,
    ]) {
      for (const modifier of ['public', 'private', 'protected', 'internal']) {
        for (const newline of ['\n', '\r\n', '\n/*c*/\n']) {
          const source = `annotation class Marker(val value: Int = 0)\nclass Foo${newline} ${annotation}\n ${modifier} constructor(val x: Int = 1)\nfun next() = 2\n`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            const captures = query.captures(tree.rootNode);
            expect(
              captures.filter(({ name }) => name === 'class').map(({ node }) => node.text),
              source
            ).toContain('Foo');
            const constructor = captures.find(
              ({ name, node }) => name === 'constructor' && node.parent?.childForFieldName('name')?.text === 'Foo'
            )!.node;
            expect(constructor.text, source).toBe(`${annotation}\n ${modifier} constructor(val x: Int = 1)`);
            expect(constructor.startIndex, source).toBe(source.indexOf(annotation));
            expect(constructor.endIndex, source).toBe(source.indexOf(')\nfun next') + 1);
            const index = source.indexOf(modifier, source.indexOf(annotation));
            const replacement = modifier === 'internal' ? 'private' : 'internal';
            const after = source.slice(0, index) + replacement + source.slice(index + modifier.length);
            const point = { row: source.slice(0, index).split('\n').length - 1, column: 1 };
            tree.edit(
              new Edit({
                startIndex: index,
                oldEndIndex: index + modifier.length,
                newEndIndex: index + replacement.length,
                startPosition: point,
                oldEndPosition: { ...point, column: 1 + modifier.length },
                newEndPosition: { ...point, column: 1 + replacement.length },
              })
            );
            const edited = parser.parse(after, tree)!;
            const fresh = parser.parse(after)!;
            try {
              expect(snapshot(edited.rootNode), after).toEqual(snapshot(fresh.rootNode));
            } finally {
              edited.delete();
              fresh.delete();
            }
          } finally {
            tree.delete();
          }
        }
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('retains local getter ownership after an unfinished nested comment', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(property_declaration (getter) @getter) @property');
  const source = 'fun f(){ val p=1\n/* unfinished\n/*closed*/ get()=2\n}';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(query.captures(tree.rootNode).map(({ name, node }) => [name, node.text])).toEqual([
      ['property', 'val p=1\n/* unfinished\n/*closed*/ get()=2'],
      ['getter', 'get()=2'],
    ]);
  } finally {
    tree.delete();
    query.delete();
    parser.delete();
  }
});

test('does not read constructor modifiers from an annotation argument', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(function_declaration name: (identifier) @name) @function');
  try {
    for (const source of [
      'class Foo\n@A( private public constructor())\nfun next()=2\n',
      'class Foo\n@A(//)\n private public constructor())\nfun next()=2\n',
      'class Foo\n@A("${f(") private constructor()")}")\nfun next()=2\n',
    ]) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const captures = query.captures(tree.rootNode);
        expect(captures.filter(({ name }) => name === 'name').map(({ node }) => node.text)).toEqual(['next']);
        const declaration = captures.find(({ name }) => name === 'function')!.node;
        expect(declaration.text).toBe(source.slice(source.indexOf('@A'), -1));
        expect(declaration.startIndex).toBe(source.indexOf('@A'));
        expect(declaration.endIndex).toBe(source.lastIndexOf('2') + 1);
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('retains constructors without modifiers when annotation strings contain constructor words', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(class_declaration name: (identifier) @class (primary_constructor) @constructor)');
  const source = 'class Foo\n@Deprecated("public constructor(")\nconstructor(val x: Int = 1)\nprivate fun f() = 1\n';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(
      query.captures(tree.rootNode).map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
    ).toEqual([
      ['class', 'Foo', 6, 9],
      ['constructor', '@Deprecated("public constructor(")\nconstructor(val x: Int = 1)', 10, 72],
    ]);
    expect(tree.rootNode.lastNamedChild?.text).toBe('private fun f() = 1');
  } finally {
    tree.delete();
    query.delete();
    parser.delete();
  }
});

test('keeps constructor text inside unfinished literals and comments out of class headers', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(class_declaration name: (identifier) @class (primary_constructor) @constructor)');
  try {
    for (const source of [
      'class Foo\n@Marker/*\n public constructor(val x: Int)\nfun next() = 2\n',
      'class Foo\n@Marker"public private\n constructor(val x: Int)\nfun next() = 2\n',
      'class Foo\n@Marker""""\n public constructor(val x: Int)\nfun next() = 2\n',
    ]) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        expect(query.captures(tree.rootNode), source).toEqual([]);
        expect(tree.rootNode.firstNamedChild?.text, source).toBe('class Foo');
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('retains annotated function ownership after constructor text in a line comment', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(function_declaration name: (identifier) @name) @function');
  const source = 'class Foo\n@Marker// public constructor(val x: Int)\nfun next() = 2\n';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.firstNamedChild?.text).toBe('class Foo');
    expect(
      query.captures(tree.rootNode).map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
    ).toEqual([
      ['function', source.slice(10, -1), 10, 65],
      ['name', 'next', 55, 59],
    ]);
  } finally {
    tree.delete();
    query.delete();
    parser.delete();
  }
});

test('retains incomplete annotated constructor recovery nodes and ranges', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const [source, expectedTree, expectedChildren] of [
      [
        'public class Foo\n    @JvmOverloads\n    constructor',
        '(source_file (class_declaration (modifiers (visibility_modifier)) name: (identifier)) (ERROR (modifiers (annotation (user_type (identifier))))))',
        [
          ['class_declaration', 'public class Foo', 0, 16],
          ['ERROR', '@JvmOverloads\n    constructor', 21, 50],
        ],
      ],
      [
        'class Foo\n @Marker\n constructor',
        '(source_file (class_declaration name: (identifier)) (ERROR (modifiers (annotation (user_type (identifier))))))',
        [
          ['class_declaration', 'class Foo', 0, 9],
          ['ERROR', '@Marker\n constructor', 11, 31],
        ],
      ],
      [
        'class Foo\n @Marker\n public constructor',
        '(source_file (class_declaration name: (identifier)) (ERROR (annotation (user_type (identifier))) (identifier) (identifier)))',
        [
          ['class_declaration', 'class Foo', 0, 9],
          ['ERROR', '@Marker\n public constructor', 11, 38],
        ],
      ],
    ] as const) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        expect(tree.rootNode.toString(), source).toBe(expectedTree);
        expect(
          tree.rootNode.namedChildren.map((node) => [node.type, node.text, node.startIndex, node.endIndex]),
          source
        ).toEqual(expectedChildren);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
