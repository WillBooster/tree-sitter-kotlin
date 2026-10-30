import { Language, Parser } from '@willbooster/web-tree-sitter';
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
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
  try {
    for (const operator of ['+', '-']) {
      for (const operand of ['value', '1', '1.5', 'call()', 'value.member', '(value)', 'values[0]']) {
        const source = `fun f() { previous${boundary}${operator}${operand}\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(tree.rootNode.descendantsOfType('binary_expression'), source).toEqual([]);
          expect(
            tree.rootNode
              .descendantsOfType('unary_expression')
              .map((node) => [node.text, node.childForFieldName('argument')?.text]),
            source
          ).toEqual([[`${operator}${operand}`, operand]]);
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

test('separates a prefix expression from a preceding comment only across a newline', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
  try {
    for (const operator of ['+', '-']) {
      for (const [separator, expected] of [
        [' ', [['binary_expression', `left /* gap */ ${operator}right`]]],
        ['\n', [['unary_expression', `${operator}right`]]],
      ] as const) {
        const source = `fun f() {\n  left${separator}/* gap */ ${operator}right\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(
            tree.rootNode
              .descendantsOfType(['unary_expression', 'binary_expression'])
              .map((node) => [node.type, node.text]),
            source
          ).toEqual(expected);
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
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

test('starts a prefix expression after a comment newline where navigation would continue', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
  const source = 'fun f() { left\n/* gap */ +member +right\n}';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(false);
    expect(
      tree.rootNode.descendantsOfType('unary_expression').map((node) => node.text),
      source
    ).toEqual(['+member']);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['\n', '\r\n', '\n/* arrow */ ', '\n/* first */ /* second */ ', '\n/* first */\n/* second */ '])(
  'keeps lambda and function-type arrows across %j',
  async (boundary) => {
    await Parser.init();
    const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
    const functionType = `(Int)${boundary}-> Int`;
    const source = `typealias Transform = ${functionType}\nfun make(): ${functionType} = { value${boundary}-> value }\nfun f() {\nval typed: ${functionType} = { value${boundary}-> value }\nval inferred = { value: Int${boundary}-> value }\nval accepted = "value".takeIf { value${boundary}-> value.isNotEmpty() }\n}\n`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      expect(
        tree.rootNode.descendantsOfType('function_type').map((node) => node.text),
        source
      ).toEqual([functionType, functionType, functionType]);
      expect(
        tree.rootNode
          .descendantsOfType('lambda_literal')
          .flatMap((node) => node.namedChildren.filter((child) => child.type === 'lambda_parameters'))
          .map((node) => node.text),
        source
      ).toEqual(['value', 'value', 'value: Int', 'value']);
      expect(tree.rootNode.descendantsOfType('unary_expression'), source).toEqual([]);
    } finally {
      tree.delete();
      parser.delete();
    }
  }
);

test.each([
  ['->value', [['lambda_parameters', 'value']]],
  ['+value', [['unary_expression', '+value']]],
] as const)('distinguishes a lambda arrow from a prefix after a comment newline in %j', async (body, expected) => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
  const source = `fun f() { val value = 2; val transform: (Int)->Int = { value\n/* gap */ ${body} }\n}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(false);
    expect(
      tree.rootNode.descendantsOfType(['lambda_parameters', 'unary_expression']).map((node) => [node.type, node.text]),
      source
    ).toEqual(expected);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each([
  ['/* x */', ['/* x */']],
  ['// line\n', ['// line']],
  ['/* αβ */', ['/* αβ */']],
  ['/* first */ /* second */', ['/* first */', '/* second */']],
  ['/* first */\r\n// 引用\r\n/* last */', ['/* first */', '// 引用\r', '/* last */']],
] as const)('retains comment text and ranges before a prefix expression in %j', async (trivia, comments) => {
  await Parser.init();
  const parser = new Parser().setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
  try {
    for (const separator of ['\t    ', '\n    ']) {
      const source = `fun f() { previous\n${trivia}${separator}+next\n}`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(
          tree.rootNode
            .descendantsOfType(['line_comment', 'block_comment'])
            .map((node) => [node.text, node.startIndex, node.endIndex]),
          source
        ).toEqual(comments.map((text) => [text, source.indexOf(text), source.indexOf(text) + text.length]));
      } finally {
        tree.delete();
      }
    }
  } finally {
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
