import { Language, type Node, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

await Parser.init();
const language = await Language.load('tree-sitter-kotlin.wasm');

test('keeps next-line actual primary constructors and their members attached to the class', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n', '\n/* header */\n']) {
      for (const modifiers of ['actual', 'actual private', 'private actual']) {
        const constructor = `${modifiers} constructor(value: T, configure: T.() -> Unit)`;
        const declaration = `actual class Server<T>${newline}${constructor} { fun work() {} }`;
        const source = `${declaration}\nfun after() {}\n`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(
            tree.rootNode.descendantsOfType('primary_constructor').map((node) => node.text),
            source
          ).toEqual([constructor]);
          const classNode = tree.rootNode.descendantsOfType('class_declaration')[0]!;
          expect(classNode.text, source).toBe(declaration);
          expect(
            classNode.descendantsOfType('function_declaration').map((node) => node.text),
            source
          ).toEqual(['fun work() {}']);
          expect(tree.rootNode.lastNamedChild?.text, source).toBe('fun after() {}');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each([
  '@Marker',
  '@Marker(1)',
  '@Marker(/*c*/1)',
  '@Marker(/*"""*/1)',
  '@Marker(/*x/*"""*/x*/1)',
  '@Deprecated("constructor")',
  '@Deprecated("$")',
  '@Deprecated("$1")',
  String.raw`@Deprecated("\$name")`,
])('keeps %s primary constructors with visibility modifiers attached to their class', (annotation) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const modifier of ['public', 'private', 'protected', 'internal']) {
      for (const newline of ['\n', '\r\n', '\n/*c*/\n']) {
        const source = `annotation class Marker(val value: Int = 0)\nclass Foo${newline} ${annotation}\n ${modifier} constructor(val x: Int = 1)\nfun next() = 2\n`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const classes = classesWithPrimaryConstructors(tree.rootNode);
          expect(
            classes.map(({ name }) => name.text),
            source
          ).toContain('Foo');
          const { constructor } = classes.find(({ name }) => name.text === 'Foo')!;
          expect(constructor.text, source).toBe(`${annotation}\n ${modifier} constructor(val x: Int = 1)`);
          expect(constructor.startIndex, source).toBe(source.indexOf(annotation));
          expect(constructor.endIndex, source).toBe(source.indexOf(')\nfun next') + 1);
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('retains local getter ownership after an unfinished nested comment', () => {
  const parser = new Parser().setLanguage(language);
  const source = 'fun f(){ val p=1\n/* unfinished\n/*closed*/ get()=2\n}';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(
      tree.rootNode
        .descendantsOfType('property_declaration')
        .map((node) => [
          node.text,
          node.namedChildren.filter((child) => child.type === 'getter').map(({ text }) => text),
        ])
    ).toEqual([['val p=1\n/* unfinished\n/*closed*/ get()=2', ['get()=2']]]);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('does not read constructor modifiers from an annotation argument', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const source of [
      'class Foo\n@A( private public constructor())\nfun next()=2\n',
      'class Foo\n@A(//)\n private public constructor())\nfun next()=2\n',
      'class Foo\n@A("${f(") private constructor()")}")\nfun next()=2\n',
    ]) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const functions = tree.rootNode.descendantsOfType('function_declaration');
        expect(functions.map((node) => node.childForFieldName('name')?.text)).toEqual(['next']);
        const declaration = functions[0]!;
        expect(declaration.text).toBe(source.slice(source.indexOf('@A'), -1));
        expect(declaration.startIndex).toBe(source.indexOf('@A'));
        expect(declaration.endIndex).toBe(source.lastIndexOf('2') + 1);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('retains constructors without modifiers when annotation strings contain constructor words', () => {
  const parser = new Parser().setLanguage(language);
  const source = 'class Foo\n@Deprecated("public constructor(")\nconstructor(val x: Int = 1)\nprivate fun f() = 1\n';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(
      classesWithPrimaryConstructors(tree.rootNode).map(({ name, constructor }) => [range(name), range(constructor)])
    ).toEqual([
      [
        ['Foo', 6, 9],
        ['@Deprecated("public constructor(")\nconstructor(val x: Int = 1)', 10, 72],
      ],
    ]);
    expect(tree.rootNode.lastNamedChild?.text).toBe('private fun f() = 1');
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('keeps constructor text inside unfinished literals and comments out of class headers', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const source of [
      'class Foo\n@Marker/*\n public constructor(val x: Int)\nfun next() = 2\n',
      'class Foo\n@Marker"public private\n constructor(val x: Int)\nfun next() = 2\n',
      'class Foo\n@Marker""""\n public constructor(val x: Int)\nfun next() = 2\n',
    ]) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        expect(classesWithPrimaryConstructors(tree.rootNode), source).toEqual([]);
        expect(tree.rootNode.firstNamedChild?.text, source).toBe('class Foo');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('retains annotated function ownership after constructor text in a line comment', () => {
  const parser = new Parser().setLanguage(language);
  const source = 'class Foo\n@Marker// public constructor(val x: Int)\nfun next() = 2\n';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.firstNamedChild?.text).toBe('class Foo');
    expect(
      tree.rootNode
        .descendantsOfType('function_declaration')
        .map((node) => [range(node), range(node.childForFieldName('name')!)])
    ).toEqual([
      [
        [source.slice(10, -1), 10, 65],
        ['next', 55, 59],
      ],
    ]);
  } finally {
    tree.delete();
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

test('retains annotated assignments after a local class with conflicting visibility words', () => {
  const parser = new Parser().setLanguage(language);
  const source = 'fun f(){ class Foo\n@A\n public private constructor() = 1\n}';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('primary_constructor')).toEqual([]);
    expect(
      tree.rootNode
        .descendantsOfType('assignment')
        .map((node) => [
          range(node),
          [node.childForFieldName('left')!.type, ...range(node.childForFieldName('left')!)],
          [node.childForFieldName('right')!.type, ...range(node.childForFieldName('right')!)],
        ])
    ).toEqual([
      [
        ['@A\n public private constructor() = 1', 19, 55],
        ['annotated_expression', '@A\n public private constructor()', 19, 51],
        ['number_literal', '1', 54, 55],
      ],
    ]);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('retains annotated infix expressions and assignments after a local class', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const modifier of ['public', 'private', 'protected', 'internal']) {
      for (const operand of ['x', '1', 'x + 1', 'call()', 'x::class', '`x`::class']) {
        for (const suffix of ['', ' = 1']) {
          const expression = `@A\n ${modifier} constructor(${operand})`;
          const source = `fun f(){ class Foo\n${expression}${suffix}\n}`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            expect(tree.rootNode.descendantsOfType('primary_constructor'), source).toEqual([]);
            const annotated = tree.rootNode
              .descendantsOfType('annotated_expression')
              .find((node) => node.namedChildren.some((child) => child.type === 'infix_expression'))!;
            expect([annotated.text, annotated.startIndex, annotated.endIndex], source).toEqual([
              expression,
              source.indexOf('@A'),
              source.indexOf('@A') + expression.length,
            ]);
          } finally {
            tree.delete();
          }
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('recognizes annotated constructors with empty or typed first parameters', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const parameters of [
      '',
      'value: Int',
      'val value: Int',
      'var value: Int',
      'vararg values: Int',
      '`value name`: Int',
      '_value: Int',
      '値: Int',
      '/*before*/ value /*after*/: Int',
      'private val value: Int',
    ]) {
      const constructor = `@A\n public constructor(${parameters})`;
      const source = `class Foo\n${constructor}\nclass After\n`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(
          tree.rootNode.descendantsOfType('primary_constructor').map((node) => [node.text, node.parent?.text]),
          source
        ).toEqual([[constructor, `class Foo\n${constructor}`]]);
        expect(tree.rootNode.lastNamedChild?.text, source).toBe('class After');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

function classesWithPrimaryConstructors(root: Node): { name: Node; constructor: Node }[] {
  return root.descendantsOfType('class_declaration').flatMap((classNode) => {
    const constructor = classNode.namedChildren.find((child) => child.type === 'primary_constructor');
    return constructor ? [{ name: classNode.childForFieldName('name')!, constructor }] : [];
  });
}

function range(node: Node): [string, number, number] {
  return [node.text, node.startIndex, node.endIndex];
}
