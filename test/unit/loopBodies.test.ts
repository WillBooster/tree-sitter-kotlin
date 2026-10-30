import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

test.each(['\n', '\r\n', '\n/* body */ ', ' /* header */\n', '\n/* first */ /* second */ ', '\n// body\n'])(
  'retains prefix loop bodies across %j',
  async (boundary) => {
    await Parser.init();
    const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
    try {
      for (const expression of [
        '-item',
        '+item',
        '-1',
        '+1.5',
        '-call()',
        '+value.member',
        '++value',
        '--value',
        '-item + other',
        '+call() - other',
      ]) {
        const source = `fun f() { for (item in values)${boundary}${expression}\nwhile (condition)${boundary}${expression}\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(
            tree.rootNode
              .descendantsOfType(['for_statement', 'while_statement'])
              .map((node) => node.childForFieldName('body')?.text),
            source
          ).toEqual([expression, expression]);
          expect(
            tree.rootNode
              .descendantsOfType('block')[0]!
              .namedChildren.filter((node) => !node.isExtra)
              .map((node) => node.type),
            source
          ).toEqual(['for_statement', 'while_statement']);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }
);

test.each([
  ['for (outer in values)\nwhile (condition)\n-item', 'for_statement', 'while_statement'],
  ['while (condition)\nfor (item in values)\n+item', 'while_statement', 'for_statement'],
  ['if (condition)\nfor (item in values)\n-item\nelse\n+value', 'if_expression', 'for_statement'],
  ['do\nfor (item in values)\n+item\nwhile (condition)', 'do_while_statement', 'for_statement'],
  ['when (condition) { true ->\nfor (item in values)\n-item\nelse ->\n+value }', 'when_expression', 'for_statement'],
])('retains nested control-body ownership in %s', async (statement, outerType, innerType) => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
  const source = `fun f() { ${statement}\n}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(false);
    const outer = tree.rootNode.descendantsOfType(outerType)[0]!;
    const inner = outer.descendantsOfType(innerType)[0]!;
    expect(inner.childForFieldName('body')?.type, source).toBe('unary_expression');
    expect(inner.childForFieldName('body')?.text, source).toMatch(/^[+-]item$/);
    expect(
      tree.rootNode
        .descendantsOfType('block')[0]!
        .namedChildren.filter((node) => !node.isExtra)
        .map((node) => node.type),
      source
    ).toEqual([outerType]);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['', '\n', '\r\n/* empty */ '])(
  'keeps prefix statements outside explicitly empty loops across %j',
  async (boundary) => {
    await Parser.init();
    const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
    const source = `fun f() { for (item in values)${boundary};\n-value\nwhile (condition)${boundary};\n+value\ndo while (condition)\n-value\n}`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      const loops = tree.rootNode.descendantsOfType(['for_statement', 'while_statement', 'do_while_statement']);
      expect(
        loops.map((node) => node.childForFieldName('body')?.text),
        source
      ).toEqual([undefined, undefined, undefined]);
      expect(
        tree.rootNode
          .descendantsOfType('block')[0]!
          .namedChildren.filter((node) => !node.isExtra)
          .map((node) => node.type),
        source
      ).toEqual([
        'for_statement',
        'unary_expression',
        'while_statement',
        'unary_expression',
        'do_while_statement',
        'unary_expression',
      ]);
    } finally {
      tree.delete();
      parser.delete();
    }
  }
);

test.each(['for (item in values)', 'while (condition)'])(
  'keeps a completed empty do-while as the body of %s',
  async (header) => {
    await Parser.init();
    const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
    const source = `fun f() { ${header} do while (condition)\n-value\n}`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      const outer = tree.rootNode.descendantsOfType(['for_statement', 'while_statement'])[0]!;
      expect(outer.childForFieldName('body')?.type, source).toBe('do_while_statement');
      expect(outer.childForFieldName('body')?.childForFieldName('body'), source).toBeNull();
      expect(
        tree.rootNode
          .descendantsOfType('block')[0]!
          .namedChildren.filter((node) => !node.isExtra)
          .map((node) => node.type),
        source
      ).toEqual([outer.type, 'unary_expression']);
    } finally {
      tree.delete();
      parser.delete();
    }
  }
);

test.each(['for (item in values)', 'while (condition)'])(
  'assigns a commented prefix statement to %s unless an empty body precedes it',
  async (header) => {
    await Parser.init();
    const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
    try {
      for (const [separator, body] of [
        ['', '-item'],
        [';', undefined],
      ] as const) {
        const source = `fun f() { ${header}${separator}\n/* body */ -item\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(
            tree.rootNode.descendantsOfType(['for_statement', 'while_statement'])[0]!.childForFieldName('body')?.text,
            source
          ).toBe(body);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }
);
