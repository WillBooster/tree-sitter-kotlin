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
  const source = `fun f() { ${statement}\n}\nfun after() {}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(true);
    expect(
      tree.rootNode
        .descendantsOfType('function_declaration')
        .some((node) => node.childForFieldName('name')?.text === 'after')
    ).toBe(true);
  } finally {
    tree.delete();
  }
});
