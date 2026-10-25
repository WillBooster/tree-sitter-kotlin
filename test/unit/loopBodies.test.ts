import { Edit, Language, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

test.each(['\n', '\r\n', '\n/* body */ ', ' /* header */\n', '\n/* first */ /* second */ ', '\n// body\n'])(
  'retains prefix loop bodies across %j',
  async (boundary) => {
    await Parser.init();
    const language = await Language.load('tree-sitter-kotlin.wasm');
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '[(for_statement body: (_) @body) (while_statement body: (_) @body)]');
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
            query.captures(tree.rootNode).map(({ node }) => node.text),
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
      query.delete();
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
  'updates prefix ownership when %s becomes empty and is undone',
  async (header) => {
    await Parser.init();
    const language = await Language.load('tree-sitter-kotlin.wasm');
    const parser = new Parser().setLanguage(language);
    const query = new Query(
      language,
      '[(for_statement) (while_statement) (unary_expression) (block_comment)] @capture'
    );
    const source = `fun f() { ${header}\n/* body */ -item\n}`;
    const index = source.indexOf(')\n') + 1;
    const after = source.slice(0, index) + ';' + source.slice(index);
    const startPosition = { row: 0, column: index };
    const newEndPosition = { row: 0, column: index + 1 };
    const tree = parser.parse(source)!;
    const trees = [tree];
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      expect(
        tree.rootNode.descendantsOfType(['for_statement', 'while_statement'])[0]!.childForFieldName('body')?.text,
        source
      ).toBe('-item');
      tree.edit(
        new Edit({
          startIndex: index,
          oldEndIndex: index,
          newEndIndex: index + 1,
          startPosition,
          oldEndPosition: startPosition,
          newEndPosition,
        })
      );
      const edited = parser.parse(after, tree)!;
      const fresh = parser.parse(after)!;
      trees.push(edited, fresh);
      expect(edited.rootNode.hasError, after).toBe(false);
      expect(captures(query, edited), after).toEqual(captures(query, fresh));
      expect(
        edited.rootNode.descendantsOfType(['for_statement', 'while_statement'])[0]!.childForFieldName('body'),
        after
      ).toBeNull();
      edited.edit(
        new Edit({
          startIndex: index,
          oldEndIndex: index + 1,
          newEndIndex: index,
          startPosition,
          oldEndPosition: newEndPosition,
          newEndPosition: startPosition,
        })
      );
      const undone = parser.parse(source, edited)!;
      const original = parser.parse(source)!;
      trees.push(undone, original);
      expect(undone.rootNode.hasError, source).toBe(false);
      expect(captures(query, undone), source).toEqual(captures(query, original));
      expect(
        undone.rootNode.descendantsOfType(['for_statement', 'while_statement'])[0]!.childForFieldName('body')?.text,
        source
      ).toBe('-item');
    } finally {
      for (const parsed of trees) parsed.delete();
      query.delete();
      parser.delete();
    }
  }
);

function captures(query: Query, tree: Tree): unknown[] {
  return query
    .captures(tree.rootNode)
    .map(({ node }) => [
      node.type,
      node.text,
      node.startIndex,
      node.endIndex,
      node.startPosition,
      node.endPosition,
      node.parent?.type,
    ]);
}
