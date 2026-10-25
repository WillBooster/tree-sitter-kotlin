import { Edit, Language, Parser, Query, type Tree } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, expect, test } from 'vitest';

let parser: Parser;
let query: Query;

beforeAll(async () => {
  await Parser.init();
  const language = await Language.load('tree-sitter-kotlin.wasm');
  parser = new Parser().setLanguage(language);
  query = new Query(language, '[("?.") (block_comment) (line_comment)] @capture');
});

afterAll(() => {
  query.delete();
  parser.delete();
});

test.each([' ', '\t', '\n', '\r\n', '\f', '/* split */', '// split\n'])(
  'rejects %j between the two safe-navigation characters',
  (boundary) => {
    for (const source of [
      `fun f(a: Box?) = a ?${boundary}. b`,
      `fun f(a: Box?) { a ?${boundary}. b\n}`,
      `class C { val result = (a ?${boundary}. b) }`,
    ]) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
        expect(
          query.captures(tree.rootNode).filter(({ node }) => node.type === '?.'),
          source
        ).toHaveLength(0);
      } finally {
        tree.delete();
      }
    }
  }
);

test.each([
  ['a?.b', ['?.']],
  ['a ?. b', ['?.']],
  ['a\n?.b', ['?.']],
  ['a?.\nb', ['?.']],
  ['a /* before */ ?.b', ['/* before */', '?.']],
  ['a?. /* after */ b', ['?.', '/* after */']],
  ['a // before\n?.b', ['// before', '?.']],
  ['a?. // after\nb', ['?.', '// after']],
] as const)('preserves safe navigation and exact trivia ranges in %s', (expression, expectedCaptures) => {
  const source = `fun f(a: Box?) = ${expression}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(false);
    expect(tree.rootNode.descendantsOfType('navigation_expression').map((node) => node.text)).toEqual([expression]);
    expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(expectedCaptures);
    for (const { node } of query.captures(tree.rootNode)) {
      if (node.type === '?.') expect(node.text).toBe('?.');
      expect(source.slice(node.startIndex, node.endIndex)).toBe(node.text);
      expect(node.endIndex - node.startIndex).toBe(node.text.length);
    }
  } finally {
    tree.delete();
  }
});

test.each([' ', '\n', '\r\n', '/* split */', '// split\n'])(
  'updates safe-navigation errors and query ranges when inserting and undoing %j',
  (boundary) => {
    const source = 'fun f(a: Box?) { val label = "引用"; val result = a?.b\nval next = 1\n}';
    const index = source.indexOf('?.') + 1;
    const changed = source.slice(0, index) + boundary + source.slice(index);
    const original = parser.parse(source)!;
    const trees = [original];
    try {
      expect(original.rootNode.hasError).toBe(false);
      const originalCaptures = captures(original);
      const startPosition = position(source, index);
      const changedEndPosition = position(changed, index + boundary.length);
      original.edit(
        new Edit({
          startIndex: index,
          oldEndIndex: index,
          newEndIndex: index + boundary.length,
          startPosition,
          oldEndPosition: startPosition,
          newEndPosition: changedEndPosition,
        })
      );
      const edited = parser.parse(changed, original)!;
      const fresh = parser.parse(changed)!;
      trees.push(edited, fresh);
      expect(edited.rootNode.hasError).toBe(true);
      expect(edited.rootNode.toString()).toBe(fresh.rootNode.toString());
      expect(captures(edited)).toEqual(captures(fresh));
      expect(query.captures(edited.rootNode).filter(({ node }) => node.type === '?.')).toHaveLength(0);
      edited.edit(
        new Edit({
          startIndex: index,
          oldEndIndex: index + boundary.length,
          newEndIndex: index,
          startPosition,
          oldEndPosition: changedEndPosition,
          newEndPosition: startPosition,
        })
      );
      const undone = parser.parse(source, edited)!;
      trees.push(undone);
      expect(undone.rootNode.hasError).toBe(false);
      expect(captures(undone)).toEqual(originalCaptures);
      expect(undone.rootNode.descendantsOfType('navigation_expression').map((node) => node.text)).toEqual(['a?.b']);
    } finally {
      for (const tree of trees) tree.delete();
    }
  }
);

function captures(tree: Tree): unknown[] {
  return query.captures(tree.rootNode).map(({ node }) => ({
    type: node.type,
    text: node.text,
    start: node.startIndex,
    end: node.endIndex,
    startPosition: node.startPosition,
    endPosition: node.endPosition,
  }));
}

function position(source: string, index: number): { row: number; column: number } {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1)!.length };
}
