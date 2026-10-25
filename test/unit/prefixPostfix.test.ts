import { Edit, Language, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

test.each([
  '\n',
  '\r\n',
  '\n/* between */',
  ' /* before */\n',
  ' // before\n',
  '\n/* first */ /* second */',
  '\r\n/* first */\r\n/* second */',
])('separates prefix expressions across %j', async (boundary) => {
  await Parser.init();
  const language = await Language.load('tree-sitter-kotlin.wasm');
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(unary_expression argument: (_) @argument) @prefix');
  try {
    for (const operator of ['+', '-']) {
      for (const operand of ['value', '1', '1.5', 'call()', 'value.member', '(value)', 'values[0]']) {
        const source = `fun f() { previous${boundary}${operator}${operand}\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.descendantsOfType('binary_expression'), source).toEqual([]);
          expect(
            query.captures(tree.rootNode).map(({ name, node }) => [name, node.text]),
            source
          ).toEqual([
            ['prefix', `${operator}${operand}`],
            ['argument', operand],
          ]);
          expect(
            tree.rootNode
              .descendantsOfType('block')[0]!
              .namedChildren.filter((node) => !node.isExtra)
              .map((node) => node.text),
            source
          ).toEqual(['previous', `${operator}${operand}`]);
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

test.each(['+', '-'])('preserves binary %s continuation and prefix increments across newlines', async (operator) => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
  try {
    for (const expression of [
      `left ${operator}\nright`,
      `left /* inside\ncomment */ ${operator}right`,
      `left\n${operator}right`,
    ]) {
      for (const statement of [
        `val result = (${expression})`,
        `consume(${expression})`,
        `values[${expression}]`,
        `if (${expression}) {}`,
      ]) {
        const source = `fun f() { ${statement}\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(
            tree.rootNode.descendantsOfType('binary_expression').map((node) => node.text),
            source
          ).toEqual([expression]);
          expect(tree.rootNode.descendantsOfType('unary_expression'), source).toEqual([]);
        } finally {
          tree.delete();
        }
      }
    }
    const source = `fun f() { left ${operator}\nright\n++value\n--value\n}`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      expect(
        tree.rootNode.descendantsOfType('binary_expression').map((node) => node.text),
        source
      ).toEqual([`left ${operator}\nright`]);
      expect(
        tree.rootNode.descendantsOfType('unary_expression').map((node) => node.text),
        source
      ).toEqual(['++value', '--value']);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});

test('updates prefix ownership and query ranges when newlines around comments change', async () => {
  await Parser.init();
  const language = await Language.load('tree-sitter-kotlin.wasm');
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '[(unary_expression) (binary_expression)] @expression');
  try {
    for (const operator of ['+', '-']) {
      const source = `fun f() {\n  left /* gap */ ${operator}right\n}`;
      const index = source.indexOf(' /* gap */');
      const after = source.slice(0, index) + '\n' + source.slice(index + 1);
      const tree = parser.parse(source)!;
      const trees = [tree];
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(
          query.captures(tree.rootNode).map(({ node }) => node.type),
          source
        ).toEqual(['binary_expression']);
        const startPosition = { row: 1, column: 6 };
        const oldEndPosition = { row: 1, column: 7 };
        const newEndPosition = { row: 2, column: 0 };
        tree.edit(
          new Edit({
            startIndex: index,
            oldEndIndex: index + 1,
            newEndIndex: index + 1,
            startPosition,
            oldEndPosition,
            newEndPosition,
          })
        );
        const edited = parser.parse(after, tree)!;
        const fresh = parser.parse(after)!;
        trees.push(edited, fresh);
        expect(edited.rootNode.hasError, after).toBe(false);
        const captures = captureRanges(query, edited);
        expect(captures, after).toEqual(captureRanges(query, fresh));
        expect(
          query.captures(edited.rootNode).map(({ node }) => [node.type, node.text]),
          after
        ).toEqual([['unary_expression', `${operator}right`]]);
        edited.edit(
          new Edit({
            startIndex: index,
            oldEndIndex: index + 1,
            newEndIndex: index + 1,
            startPosition,
            oldEndPosition: newEndPosition,
            newEndPosition: oldEndPosition,
          })
        );
        const undone = parser.parse(source, edited)!;
        const original = parser.parse(source)!;
        trees.push(undone, original);
        expect(undone.rootNode.hasError, source).toBe(false);
        expect(captureRanges(query, undone), source).toEqual(captureRanges(query, original));
      } finally {
        for (const parsed of trees) parsed.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test.each(['\n/* gap */ ', '\r\n/* first */ /* second */ ', '\n/* first */\n/* second */ '])(
  'does not carry a comment newline past navigation across %j',
  async (boundary) => {
    await Parser.init();
    const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
    try {
      for (const expression of [
        `left${boundary}.member +right`,
        `left${boundary}.identity<Value>() +right`,
        `(left${boundary}?.member)!! +right`,
      ]) {
        const source = `fun f() { ${expression}\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(
            tree.rootNode.descendantsOfType('binary_expression').map((node) => node.text),
            source
          ).toEqual([expression]);
          expect(
            tree.rootNode
              .descendantsOfType('unary_expression')
              .filter((node) => node.childForFieldName('operator')?.text === '+'),
            source
          ).toEqual([]);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }
);

test('invalidates comment lookahead when navigation becomes a prefix and is undone', async () => {
  await Parser.init();
  const language = await Language.load('tree-sitter-kotlin.wasm');
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '[(unary_expression) (binary_expression)] @expression');
  const source = 'fun f() { left\n/* gap */ .member +right\n}';
  const index = source.indexOf('.member');
  const after = source.slice(0, index) + '+' + source.slice(index + 1);
  const tree = parser.parse(source)!;
  const trees = [tree];
  const edit = new Edit({
    startIndex: index,
    oldEndIndex: index + 1,
    newEndIndex: index + 1,
    startPosition: { row: 1, column: 10 },
    oldEndPosition: { row: 1, column: 11 },
    newEndPosition: { row: 1, column: 11 },
  });
  try {
    expect(tree.rootNode.hasError).toBe(false);
    tree.edit(edit);
    const edited = parser.parse(after, tree)!;
    const fresh = parser.parse(after)!;
    trees.push(edited, fresh);
    expect(edited.rootNode.hasError, after).toBe(false);
    expect(captureRanges(query, edited), after).toEqual(captureRanges(query, fresh));
    expect(
      edited.rootNode.descendantsOfType('unary_expression').map((node) => node.text),
      after
    ).toEqual(['+member']);
    edited.edit(edit);
    const undone = parser.parse(source, edited)!;
    const original = parser.parse(source)!;
    trees.push(undone, original);
    expect(undone.rootNode.hasError, source).toBe(false);
    expect(captureRanges(query, undone), source).toEqual(captureRanges(query, original));
    expect(
      undone.rootNode.descendantsOfType('binary_expression').map((node) => node.text),
      source
    ).toEqual(['left\n/* gap */ .member +right']);
  } finally {
    for (const parsed of trees) parsed.delete();
    query.delete();
    parser.delete();
  }
});

test.each(['\n', '\r\n', '\n/* arrow */ ', '\n/* first */ /* second */ ', '\n/* first */\n/* second */ '])(
  'keeps lambda and function-type arrows across %j',
  async (boundary) => {
    await Parser.init();
    const language = await Language.load('tree-sitter-kotlin.wasm');
    const parser = new Parser().setLanguage(language);
    const query = new Query(language, '(lambda_literal (lambda_parameters) @parameters) (function_type) @type');
    const functionType = `(Int)${boundary}-> Int`;
    const source = `typealias Transform = ${functionType}\nfun make(): ${functionType} = { value${boundary}-> value }\nfun f() {\nval typed: ${functionType} = { value${boundary}-> value }\nval inferred = { value: Int${boundary}-> value }\nval accepted = "value".takeIf { value${boundary}-> value.isNotEmpty() }\n}\n`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      const captures = query.captures(tree.rootNode);
      expect(
        captures.filter(({ name }) => name === 'type').map(({ node }) => node.text),
        source
      ).toEqual([functionType, functionType, functionType]);
      expect(
        captures.filter(({ name }) => name === 'parameters').map(({ node }) => node.text),
        source
      ).toEqual(['value', 'value', 'value: Int', 'value']);
      expect(tree.rootNode.descendantsOfType('unary_expression'), source).toEqual([]);
    } finally {
      tree.delete();
      query.delete();
      parser.delete();
    }
  }
);

test('updates comment lookahead when a lambda arrow becomes a prefix and is undone', async () => {
  await Parser.init();
  const language = await Language.load('tree-sitter-kotlin.wasm');
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '[(lambda_parameters) (unary_expression)] @expression');
  const source = 'fun f() { val value = 2; val transform: (Int)->Int = { value\n/* gap */ ->value }\n}';
  const index = source.lastIndexOf('->');
  const after = source.slice(0, index) + '+' + source.slice(index + 2);
  const tree = parser.parse(source)!;
  const trees = [tree];
  const startPosition = { row: 1, column: 10 };
  const oldEndPosition = { row: 1, column: 12 };
  const newEndPosition = { row: 1, column: 11 };
  try {
    expect(tree.rootNode.hasError, source).toBe(false);
    expect(
      query.captures(tree.rootNode).map(({ node }) => [node.type, node.text]),
      source
    ).toEqual([['lambda_parameters', 'value']]);
    tree.edit(
      new Edit({
        startIndex: index,
        oldEndIndex: index + 2,
        newEndIndex: index + 1,
        startPosition,
        oldEndPosition,
        newEndPosition,
      })
    );
    const edited = parser.parse(after, tree)!;
    const fresh = parser.parse(after)!;
    trees.push(edited, fresh);
    expect(edited.rootNode.hasError, after).toBe(false);
    expect(captureRanges(query, edited), after).toEqual(captureRanges(query, fresh));
    expect(
      query.captures(edited.rootNode).map(({ node }) => [node.type, node.text]),
      after
    ).toEqual([['unary_expression', '+value']]);
    edited.edit(
      new Edit({
        startIndex: index,
        oldEndIndex: index + 1,
        newEndIndex: index + 2,
        startPosition,
        oldEndPosition: newEndPosition,
        newEndPosition: oldEndPosition,
      })
    );
    const undone = parser.parse(source, edited)!;
    const original = parser.parse(source)!;
    trees.push(undone, original);
    expect(undone.rootNode.hasError, source).toBe(false);
    expect(captureRanges(query, undone), source).toEqual(captureRanges(query, original));
    expect(
      query.captures(undone.rootNode).map(({ node }) => node.type),
      source
    ).toEqual(['lambda_parameters']);
  } finally {
    for (const parsed of trees) parsed.delete();
    query.delete();
    parser.delete();
  }
});

test.each([
  ['/* x */', ['/* x */']],
  ['// line\n', ['// line']],
  ['/* αβ */', ['/* αβ */']],
  ['/* first */ /* second */', ['/* first */', '/* second */']],
  ['/* first */\r\n// 引用\r\n/* last */', ['/* first */', '// 引用\r', '/* last */']],
] as const)('retains comment text and ranges across prefix lookahead in %j', async (trivia, comments) => {
  await Parser.init();
  const language = await Language.load('tree-sitter-kotlin.wasm');
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '[(line_comment) (block_comment) (unary_expression)] @capture');
  const source = `fun f() { previous\n${trivia}\t    +next\n}`;
  const index = source.lastIndexOf('\t    ');
  const after = source.slice(0, index) + '\n' + source.slice(index + 1);
  const lines = source.slice(0, index).split('\n');
  const startPosition = { row: lines.length - 1, column: lines.at(-1)!.length };
  const oldEndPosition = { ...startPosition, column: startPosition.column + 1 };
  const newEndPosition = { row: startPosition.row + 1, column: 0 };
  const tree = parser.parse(source)!;
  const trees = [tree];
  try {
    expect(tree.rootNode.hasError, source).toBe(false);
    expect(
      tree.rootNode
        .descendantsOfType(['line_comment', 'block_comment'])
        .map((node) => [node.text, node.startIndex, node.endIndex]),
      source
    ).toEqual(comments.map((text) => [text, source.indexOf(text), source.indexOf(text) + text.length]));
    tree.edit(
      new Edit({
        startIndex: index,
        oldEndIndex: index + 1,
        newEndIndex: index + 1,
        startPosition,
        oldEndPosition,
        newEndPosition,
      })
    );
    const edited = parser.parse(after, tree)!;
    const fresh = parser.parse(after)!;
    trees.push(edited, fresh);
    expect(edited.rootNode.hasError, after).toBe(false);
    expect(captureRanges(query, edited), after).toEqual(captureRanges(query, fresh));
    expect(
      edited.rootNode.descendantsOfType(['line_comment', 'block_comment']).map((node) => node.text),
      after
    ).toEqual(comments);
    edited.edit(
      new Edit({
        startIndex: index,
        oldEndIndex: index + 1,
        newEndIndex: index + 1,
        startPosition,
        oldEndPosition: newEndPosition,
        newEndPosition: oldEndPosition,
      })
    );
    const undone = parser.parse(source, edited)!;
    const original = parser.parse(source)!;
    trees.push(undone, original);
    expect(undone.rootNode.hasError, source).toBe(false);
    expect(captureRanges(query, undone), source).toEqual(captureRanges(query, original));
    expect(
      undone.rootNode.descendantsOfType(['line_comment', 'block_comment']).map((node) => node.text),
      source
    ).toEqual(comments);
  } finally {
    for (const parsed of trees) parsed.delete();
    query.delete();
    parser.delete();
  }
});

test('keeps postfix operators inside prefix operands and before following calls', async () => {
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
  const tree = parser.parse(`class Counter(var value: Int)
fun postfixed(counter: Counter) = -counter.value++
fun nullable(counter: Counter?) = -counter?.value!!
fun called(counter: Counter) = -counter.value!!.inc()`)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const functions = tree.rootNode.descendantsOfType('function_declaration');
    for (const [index, operand, operator] of [
      [0, 'counter.value++', '++'],
      [1, 'counter?.value!!', '!!'],
    ] as const) {
      const prefix = functions[index]!.descendantsOfType('unary_expression')[0]!;
      expect(prefix.childForFieldName('operator')?.text).toBe('-');
      const argument = prefix.childForFieldName('argument');
      expect(argument?.text).toBe(operand);
      expect(argument?.childForFieldName('operator')?.text).toBe(operator);
    }
    const prefix = functions[2]!.descendantsOfType('unary_expression')[0]!;
    expect(prefix.childForFieldName('operator')?.text).toBe('-');
    expect(prefix.childForFieldName('argument')?.type).toBe('call_expression');
    expect(prefix.childForFieldName('argument')?.text).toBe('counter.value!!.inc()');
  } finally {
    tree.delete();
    parser.delete();
  }
});

function captureRanges(query: Query, tree: Tree): unknown[] {
  return query
    .captures(tree.rootNode)
    .map(({ node }) => [node.type, node.text, node.startIndex, node.endIndex, node.startPosition, node.endPosition]);
}
