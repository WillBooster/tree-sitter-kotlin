import { expect, test } from 'vitest';
import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';

await Parser.init();
const language = await Language.load('tree-sitter-kotlin.wasm');
const snapshot = (node: NonNullable<ReturnType<Parser['parse']>>['rootNode']): unknown => [
  node.type,
  node.grammarType,
  node.isNamed,
  node.isExtra,
  node.isMissing,
  node.hasError,
  node.startIndex,
  node.endIndex,
  node.startPosition,
  node.endPosition,
  node.children.map((_, i) => node.fieldNameForChild(i)),
  node.children.map(snapshot),
];

test('keeps annotated primary constructors with visibility modifiers attached to their class', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(class_declaration name: (identifier) @class (primary_constructor) @constructor)');
  try {
    for (const annotation of ['@Marker', '@Marker(1)', '@Marker(/*c*/1)', '@Deprecated("constructor")']) {
      for (const modifier of ['public', 'private', 'protected', 'internal']) {
        for (const newline of ['\n', '\r\n', '\n/*c*/\n']) {
          const source = `annotation class Marker(val value: Int = 0)\nclass Foo${newline} ${annotation}\n ${modifier} constructor(val x: Int = 1)\nfun next() = 2\n`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            const captures = query.captures(tree.rootNode);
            expect(
              captures.filter(({ name }) => name === 'class').map(({ node }) => node.text),
              source
            ).toContain('Foo');
            const constructor = captures.find(
              ({ name, node }) => name === 'constructor' && node.parent?.childForFieldName('name')?.text === 'Foo'
            )!.node;
            expect(constructor.text, source).toBe(`${annotation}\n ${modifier} constructor(val x: Int = 1)`);
            expect(constructor.startIndex, source).toBe(source.indexOf(annotation));
            expect(constructor.endIndex, source).toBe(source.indexOf(')\nfun next') + 1);
            const index = source.indexOf(modifier, source.indexOf(annotation));
            const after = source.slice(0, index) + 'internal' + source.slice(index + modifier.length);
            const point = { row: source.slice(0, index).split('\n').length - 1, column: 1 };
            tree.edit(
              new Edit({
                startIndex: index,
                oldEndIndex: index + modifier.length,
                newEndIndex: index + 8,
                startPosition: point,
                oldEndPosition: { ...point, column: 1 + modifier.length },
                newEndPosition: { ...point, column: 9 },
              })
            );
            const edited = parser.parse(after, tree)!;
            const fresh = parser.parse(after)!;
            try {
              expect(snapshot(edited.rootNode), after).toEqual(snapshot(fresh.rootNode));
            } finally {
              edited.delete();
              fresh.delete();
            }
          } finally {
            tree.delete();
          }
        }
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('retains local getter ownership after an unfinished nested comment', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(property_declaration (getter) @getter) @property');
  const source = 'fun f(){ val p=1\n/* unfinished\n/*closed*/ get()=2\n}';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(query.captures(tree.rootNode).map(({ name, node }) => [name, node.text])).toEqual([
      ['property', 'val p=1\n/* unfinished\n/*closed*/ get()=2'],
      ['getter', 'get()=2'],
    ]);
  } finally {
    tree.delete();
    query.delete();
    parser.delete();
  }
});
