import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, expect, test } from 'vitest';

let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser().setLanguage(
    await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'))
  );
});

afterAll(() => parser.delete());

test.each([
  ['val [first, second,] = pair', '[first, second,]', ['first', 'second']],
  ['var [first: Int, second: Int] = pair', '[first: Int, second: Int]', ['first: Int', 'second: Int']],
  ['[val first, var second,] = pair', '[val first, var second,]', ['val first', 'var second']],
  [
    '(val left = first, var right: Int = second,) = pair',
    '(val left = first, var right: Int = second,)',
    ['val left = first', 'var right: Int = second'],
  ],
  ['val (left = first, right = second,) = pair', '(left = first, right = second,)', ['left = first', 'right = second']],
  ['for ([first, second,] in listOf(pair)) { consume(first, second) }', '[first, second,]', ['first', 'second']],
  [
    'for ([val first, val second] in listOf(pair)) { consume(first, second) }',
    '[val first, val second]',
    ['val first', 'val second'],
  ],
  [
    'for ((val left = first, val right = second) in listOf(pair)) { consume(left, right) }',
    '(val left = first, val right = second)',
    ['val left = first', 'val right = second'],
  ],
  ['listOf(pair).forEach { [first, second] -> consume(first, second) }', '[first, second]', ['first', 'second']],
  [
    'listOf(pair).forEach { [val first, val second] -> consume(first, second) }',
    '[val first, val second]',
    ['val first', 'val second'],
  ],
  [
    'listOf(pair).forEach { (val left = first, val right = second) -> consume(left, right) }',
    '(val left = first, val right = second)',
    ['val left = first', 'val right = second'],
  ],
])('parses destructuring in %s', (statement, binding, entries) => {
  const source = `fun f(pair: Pair<Int, Int>) { ${statement}\nconsume(pair)\n}\nfun after() {}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(false);
    expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([
      'function_declaration',
      'function_declaration',
    ]);
    const destructuring = tree.rootNode.descendantsOfType('multi_variable_declaration');
    expect(destructuring.map((node) => node.text)).toEqual([binding]);
    expect(destructuring[0]!.namedChildren.map((node) => node.text)).toEqual(entries);
    expect(destructuring[0]!.startIndex).toBe(source.indexOf(binding));
    expect(destructuring[0]!.endIndex).toBe(source.indexOf(binding) + binding.length);
    expect(tree.rootNode.descendantsOfType('call_expression').some((node) => node.text === 'consume(pair)')).toBe(true);
  } finally {
    tree.delete();
  }
});

test.each(['[first, second]', '[val first, val second]', '(val left = first, val right = second)'])(
  'keeps a type annotation on the entire destructuring lambda parameter %s',
  (binding) => {
    const source = `val action = { ${binding}: Pair<Int, Int>, other: Int -> other }`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      const parameters = tree.rootNode.descendantsOfType('lambda_parameters')[0]!.namedChildren;
      expect(parameters.map((node) => node.text)).toEqual([`${binding}: Pair<Int, Int>`, 'other: Int']);
      expect(parameters[0]!.childForFieldName('type')?.text).toBe('Pair<Int, Int>');
    } finally {
      tree.delete();
    }
  }
);

test.each([
  'for ([var first, val second] in pairs) {}',
  'for ((val first, var second) in pairs) {}',
  'pairs.forEach { [var first, val second] -> first }',
  'pairs.forEach { (val first, var second) -> first }',
  '[val first = member, val second] = pair',
  '(val @Ann first, val second) = pair',
  '[val first, second] = pair',
])('reports invalid destructuring in %s', (statement) => {
  const source = `fun f() { ${statement}\n}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(true);
  } finally {
    tree.delete();
  }
});

test.each(['(val first, val second)', '[val first, var second]'])(
  'reports a full destructuring declaration in a class body: %s',
  (binding) => {
    const source = `class C { ${binding} = pair }`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(true);
    } finally {
      tree.delete();
    }
  }
);

test.each(['\n', '\r\n', '\n/* boundary */ ', ' // boundary\n'])(
  'separates consecutive bracket destructuring declarations across %j',
  (boundary) => {
    for (const trivia of ['', ' /* entries */ ', '\n', ' // entries\n']) {
      const first = `[${trivia}val first, val second] = pair`;
      const second = `[${trivia}var left, val right] = pair`;
      const statements = ['consume(pair)', first, second, 'consume(first, second, left, right)'];
      const source = `fun f() { ${statements.slice(0, 3).join(boundary)}\n${statements[3]}\n}`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('destructuring_declaration').map((node) => node.text)).toEqual([
          first,
          second,
        ]);
        expect(
          tree.rootNode
            .descendantsOfType(['block_comment', 'line_comment'])
            .map((node) => [node.text, node.startIndex, node.endIndex])
        ).toEqual(
          [...source.matchAll(/\/\* (?:boundary|entries) \*\/|\/\/ (?:boundary|entries)/g)].map((match) => [
            match[0],
            match.index,
            match.index + match[0].length,
          ])
        );
        expect(
          tree.rootNode
            .descendantsOfType('block')[0]!
            .namedChildren.filter((node) => !node.isExtra)
            .map((node) => node.text)
        ).toEqual(statements);
      } finally {
        tree.delete();
      }
    }
  }
);

test('keeps multiline indexing inside a call argument', () => {
  const index = 'values\n[index]';
  const source = `fun f(values: IntArray, index: Int) { consume(${index}) }`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('index_expression').map((node) => node.text)).toEqual([index]);
    expect(tree.rootNode.descendantsOfType('destructuring_declaration')).toEqual([]);
  } finally {
    tree.delete();
  }
});

test.each(['[first, second]', '[first, second].forEach { consume(it) }', '[]'])(
  'keeps a lambda-leading collection literal as an expression: %s',
  (body) => {
    const result = body.includes('.forEach') ? 'Unit' : 'List<Int>';
    const source = `fun f(first: Int, second: Int) { val action: () -> ${result} = { ${body} } }`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      expect(tree.rootNode.descendantsOfType('lambda_parameters')).toEqual([]);
      expect(tree.rootNode.descendantsOfType('collection_literal').map((node) => node.text)).toEqual([
        body.startsWith('[]') ? '[]' : '[first, second]',
      ]);
      expect(tree.rootNode.descendantsOfType('lambda_literal')[0]!.namedChildren[0]!.text).toBe(body);
    } finally {
      tree.delete();
    }
  }
);

test.each(['@Ann ', '@Ann() ', '@First @Second ', '@pkg.Ann("tag") '])(
  'attaches annotations to full destructuring declarations: %s',
  (annotations) => {
    for (const binding of ['(val first, var second)', '[val first, var second]']) {
      for (const prefix of ['', 'consume(pair)\n']) {
        const declaration = `${annotations}${binding} = pair`;
        const source = `fun f() { ${prefix}${declaration}\nconsume(first, second)\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const declarations = tree.rootNode.descendantsOfType('destructuring_declaration');
          expect(declarations.map((node) => node.text)).toEqual([declaration]);
          expect(declarations[0]!.namedChildren[0]!.type).toBe('modifiers');
          expect(declarations[0]!.namedChildren[0]!.text).toBe(annotations.trim());
          expect(declarations[0]!.descendantsOfType('multi_variable_declaration').map((node) => node.text)).toEqual([
            binding,
          ]);
        } finally {
          tree.delete();
        }
      }
    }
  }
);
