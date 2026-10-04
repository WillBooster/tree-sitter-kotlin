import { expect, test } from 'vitest';
import path from 'node:path';
import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';

await Parser.init();
const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));

const incompleteHeaders = [
  'class Foo\n@A/*c*/\nconstructor',
  'class Foo\n@A(run { class Local; 1 }) constructor',
  'class Foo\n@A\ninternal constructor',
  'class Foo\n@A private constructor\nval x = 1',
];

test('keeps annotated class headers queryable while completing their constructors', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, '(class_declaration name: (identifier) @name)');
  for (const source of incompleteHeaders) {
    const tree = parser.parse(source)!;
    expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toContain('Foo');
    const index = source.indexOf('constructor') + 'constructor'.length;
    const prefix = source.slice(0, index).split('\n');
    const point = { row: prefix.length - 1, column: prefix.at(-1)!.length };
    tree.edit(
      new Edit({
        startIndex: index,
        oldEndIndex: index,
        newEndIndex: index + 2,
        startPosition: point,
        oldEndPosition: point,
        newEndPosition: { row: point.row, column: point.column + 2 },
      })
    );
    const completedSource = `${source.slice(0, index)}()${source.slice(index)}`;
    const completed = parser.parse(completedSource, tree)!;
    const fresh = parser.parse(completedSource)!;
    expect(completed.rootNode.toString()).toBe(fresh.rootNode.toString());
    expect(fresh.rootNode.hasError).toBe(false);
    expect(fresh.rootNode.descendantsOfType('primary_constructor')).toHaveLength(1);
    tree.delete();
    completed.delete();
    fresh.delete();
  }
  query.delete();
  parser.delete();
});

test('an explicit semicolon separates annotations from constructor and getter attachment', () => {
  const parser = new Parser();
  parser.setLanguage(language);
  for (const source of ['class Foo;\n@A constructor()', 'class Foo { val x = 1;\n@A get() = field }']) {
    const tree = parser.parse(source)!;
    expect(tree.rootNode.descendantsOfType('class_declaration')).toHaveLength(1);
    expect(tree.rootNode.descendantsOfType('primary_constructor')).toHaveLength(0);
    expect(tree.rootNode.descendantsOfType('getter')).toHaveLength(0);
    tree.delete();
  }
  parser.delete();
});
