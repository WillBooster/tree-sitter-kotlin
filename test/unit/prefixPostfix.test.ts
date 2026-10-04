import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

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
