import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

test('groups a destructuring annotation with its complete lambda parameter', async () => {
  await Parser.init();
  const parser = new Parser();
  const language = await Language.load('tree-sitter-kotlin.wasm');
  parser.setLanguage(language);
  const source = 'val f = { (left, right): Pair<Int, Int>, other: Int -> left + other }';
  const tree = parser.parse(source)!;
  const query = new Query(language, '(lambda_parameters) @parameters');
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const parameters = query.captures(tree.rootNode)[0]!.node.namedChildren;
    expect(parameters.map((node) => node.text)).toEqual(['(left, right): Pair<Int, Int>', 'other: Int']);
    expect(parameters[0]!.type).toBe('multi_variable_declaration');
    expect(parameters[0]!.childForFieldName('type')?.text).toBe('Pair<Int, Int>');
    expect(parameters[1]!.type).toBe('variable_declaration');
  } finally {
    query.delete();
    tree.delete();
    parser.delete();
  }
});

test('keeps declarations after an unfinished destructuring annotation', async () => {
  await Parser.init();
  const parser = new Parser();
  const language = await Language.load('tree-sitter-kotlin.wasm');
  parser.setLanguage(language);
  const query = new Query(language, '(property_declaration) @property');
  try {
    for (const gap of ['', '\n']) {
      const source = `fun f(list: List<Pair<Int, Int>>) {
  val mapped = list.map { (a, b):${gap} }
  val total = 1
  println(total)
}`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError).toBe(true);
        expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual(['function_declaration']);
        expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([
          `val mapped = list.map { (a, b):${gap} }`,
          'val total = 1',
        ]);
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('keeps statements after an unfinished destructuring annotation before hard keywords', async () => {
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load('tree-sitter-kotlin.wasm'));
  try {
    for (const [statement, kind] of [
      ['val inner = 1', 'property_declaration'],
      ['return', 'return_expression'],
      ['if (x > 1) println(x)', 'if_expression'],
    ]) {
      for (const gap of [' ', '\n']) {
        const source = `fun f() { list.map { (a, b):${gap}${statement} }\n val after = 2\n println(after)\n}`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual(['function_declaration']);
          expect(tree.rootNode.descendantsOfType(kind!).some((node) => node.text === statement)).toBe(true);
          expect(
            tree.rootNode.descendantsOfType('property_declaration').some((node) => node.text === 'val after = 2')
          ).toBe(true);
          expect(
            tree.rootNode.descendantsOfType('call_expression').some((node) => node.text === 'println(after)')
          ).toBe(true);
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});
