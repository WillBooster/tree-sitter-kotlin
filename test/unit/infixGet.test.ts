import path from 'node:path';

import { Edit, Language, Parser, Query, type Node, type Point, type Tree } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

const source = `class Row(val id: Int) {
    infix fun get(column: Int): Int = id + column
}
fun Row.insert(block: () -> Unit): Row {
    block()
    return this
}
fun main() {
    val row = Row(2)
    val first = row.insert {
        println("insert")
    } get row.id
    val second = row get 3
    check(first == 4)
    check(second == 5)
    println(listOf(first, second))
}
`;

interface PublicNode {
  type: string;
  text: string;
  named: boolean;
  extra: boolean;
  missing: boolean;
  error: boolean;
  hasError: boolean;
  start: number;
  end: number;
  startPoint: Point;
  endPoint: Point;
  children: { field: string | undefined; node: PublicNode }[];
}

test('keeps get as the infix identifier after ordinary and trailing-lambda receivers', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser();
  let query: Query | undefined;
  let tree: Tree | undefined;
  try {
    parser.setLanguage(language);
    query = new Query(language, '(infix_expression) @infix\n(infix_expression (identifier) @name)');
    tree = parser.parse(source)!;
    expect(tree.rootNode.hasError).toBe(false);
    const infixes = query.captures(tree.rootNode).filter(({ name }) => name === 'infix');
    expect(infixes.map(({ node }) => node.text)).toEqual([
      'row.insert {\n        println("insert")\n    } get row.id',
      'row get 3',
    ]);
    expect(infixes.map(({ node }) => node.namedChildren.map((child) => child.type))).toEqual([
      ['call_expression', 'identifier', 'navigation_expression'],
      ['identifier', 'identifier', 'number_literal'],
    ]);
    const names = query.captures(tree.rootNode).filter(({ name, node }) => name === 'name' && node.text === 'get');
    expect(names).toHaveLength(2);
    for (const [index, { node }] of names.entries()) {
      const infix = infixes[index]!.node;
      expect(node.parent?.id).toBe(infix.id);
      expect(node.startIndex).toBe(source.indexOf(' get ', infix.startIndex) + 1);
      expect(node.endIndex).toBe(node.startIndex + 3);
      expect(node.startPosition).toEqual(pointAt(source, node.startIndex));
      expect(node.endPosition).toEqual(pointAt(source, node.endIndex));
      expect(infix.startIndex).toBe(source.indexOf(infix.text));
      expect(infix.endIndex).toBe(infix.startIndex + infix.text.length);
    }
    expect(infixes[0]!.node.namedChildren[0]!.descendantsOfType('annotated_lambda')).toHaveLength(1);
    expect(tree.rootNode.descendantsOfType(['getter', 'setter'])).toHaveLength(0);
  } finally {
    tree?.delete();
    query?.delete();
    parser.delete();
  }
});

test('replays length-changing infix receiver and name edits with exact fresh public trees and captures', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser();
  let query: Query | undefined;
  let tree: Tree | undefined;
  let text = source;
  try {
    parser.setLanguage(language);
    query = new Query(language, '(infix_expression) @infix\n(infix_expression (identifier) @identifier)');
    tree = parser.parse(text)!;
    for (const [anchor, before, after, offset, expected] of [
      ['row get 3', 'row', 'longerReceiver', 0, 'longerReceiver get 3'],
      ['longerReceiver get 3', 'get', 'getValue', 15, 'longerReceiver getValue 3'],
      ['longerReceiver getValue 3', 'longerReceiver', 'r', 0, 'r getValue 3'],
      ['r getValue 3', 'getValue', 'get', 2, 'r get 3'],
      ['r get 3', 'r', 'row', 0, 'row get 3'],
      ['row.insert {', 'row', 'longerEntry', 0, 'longerEntry.insert {\n        println("insert")\n    } get row.id'],
      ['longerEntry.insert {', 'longerEntry', 'row', 0, 'row.insert {\n        println("insert")\n    } get row.id'],
    ] as const) {
      const anchorStart = text.indexOf(anchor);
      expect(anchorStart).toBeGreaterThanOrEqual(0);
      const start = anchorStart + offset;
      expect(text.slice(start, start + before.length)).toBe(before);
      const nextText = text.slice(0, start) + after + text.slice(start + before.length);
      const previous: Tree = tree!;
      tree = undefined;
      let fresh: Tree | undefined;
      try {
        previous.edit(
          new Edit({
            startIndex: start,
            oldEndIndex: start + before.length,
            newEndIndex: start + after.length,
            startPosition: pointAt(text, start),
            oldEndPosition: pointAt(text, start + before.length),
            newEndPosition: pointAt(nextText, start + after.length),
          })
        );
        tree = parser.parse(nextText, previous)!;
        fresh = parser.parse(nextText)!;
        expect(tree.rootNode.hasError).toBe(false);
        expect(snapshot(tree.rootNode)).toEqual(snapshot(fresh.rootNode));
        expect(captures(query, tree)).toEqual(captures(query, fresh));
        expect(tree.rootNode.descendantsOfType('infix_expression').map((node) => node.text)).toContain(expected);
      } finally {
        fresh?.delete();
        previous.delete();
      }
      text = nextText;
    }
  } finally {
    tree?.delete();
    query?.delete();
    parser.delete();
  }
});

test('retains getter ownership and incomplete member identifiers beside contextual get calls', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser();
  let query: Query | undefined;
  try {
    parser.setLanguage(language);
    query = new Query(language, '(getter) @getter\n(setter) @setter\n(identifier) @identifier');
    for (const text of [
      'val p=1\n/* unfinished\n/*closed*/ get()=2',
      'fun f(){ val p=1\n/* unfinished\n/*closed*/ get()=2\n}',
      'class Foo{ val p=1\n/* unfinished\n/*closed*/ get()=2\n}',
      'class C { var p:Int=1\n get(/* parameter comment */)=field\n set(value){field=value} }',
    ]) {
      const tree = parser.parse(text)!;
      try {
        expect(tree.rootNode.hasError, text).toBe(false);
        const getters = query.captures(tree.rootNode).filter(({ name }) => name === 'getter');
        expect(getters).toHaveLength(1);
        const getter = getters[0]!.node;
        expect(getter.parent?.type).toBe('property_declaration');
        expect(getter.startIndex).toBe(text.indexOf('get('));
        expect(getter.text).toBe(text.includes('parameter comment') ? 'get(/* parameter comment */)=field' : 'get()=2');
        expect(getter.endIndex).toBe(getter.startIndex + getter.text.length);
        const setters = query.captures(tree.rootNode).filter(({ name }) => name === 'setter');
        expect(setters.map(({ node }) => node.text)).toEqual(
          text.includes('set(value)') ? ['set(value){field=value}'] : []
        );
        expect(tree.rootNode.descendantsOfType('infix_expression')).toHaveLength(0);
      } finally {
        tree.delete();
      }
    }
    for (const text of ['fun f() { val p: Int\nprivate get }', 'val l = { val p: Int\nprivate get }']) {
      const tree = parser.parse(text)!;
      try {
        expect(tree.rootNode.hasError, text).toBe(true);
        expect(
          query.captures(tree.rootNode).filter(({ name, node }) => name === 'identifier' && node.text === 'get')
        ).toHaveLength(1);
        expect(tree.rootNode.descendantsOfType('property_declaration').map((node) => node.text)).toContain(
          'val p: Int'
        );
      } finally {
        tree.delete();
      }
    }
  } finally {
    query?.delete();
    parser.delete();
  }
});

function pointAt(text: string, index: number): Point {
  const preceding = text.slice(0, index).split('\n');
  return { row: preceding.length - 1, column: preceding.at(-1)!.length };
}

function captures(query: Query, tree: Tree): { name: string; node: PublicNode }[] {
  return query.captures(tree.rootNode).map(({ name, node }) => ({ name, node: snapshot(node) }));
}

function snapshot(node: Node): PublicNode {
  return {
    type: node.type,
    text: node.text,
    named: node.isNamed,
    extra: node.isExtra,
    missing: node.isMissing,
    error: node.isError,
    hasError: node.hasError,
    start: node.startIndex,
    end: node.endIndex,
    startPoint: node.startPosition,
    endPoint: node.endPosition,
    children: node.children.map((child, index) => ({
      field: node.fieldNameForChild(index) ?? undefined,
      node: snapshot(child),
    })),
  };
}
