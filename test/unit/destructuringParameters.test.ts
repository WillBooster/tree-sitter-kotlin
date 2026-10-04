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
