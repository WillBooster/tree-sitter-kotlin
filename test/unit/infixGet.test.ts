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

test('retains get call operands of return and throw through name and trivia edits', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(call_expression) @call (infix_expression) @infix (identifier) @identifier');
  try {
    for (const [prefix, argumentsText, owner] of [
      ['return ', '(1)', 'return_expression'],
      ['return ', '(1, 2)', 'return_expression'],
      ['return ', '()', 'return_expression'],
      ['return@f ', '(1, 2)', 'return_expression'],
      ['throw ', '(1, 2)', 'throw_expression'],
    ] as const) {
      let text = `fun f() { ${prefix}get${argumentsText} }`;
      let tree = parser.parse(text)!;
      try {
        check(tree, text, 'get');
        for (const name of ['getValue', 'get']) {
          const start = text.indexOf('get');
          const end = start + (text.startsWith('getValue', start) ? 'getValue'.length : 'get'.length);
          const replacement = `${name} /* call boundary */ `;
          const next = text.slice(0, start) + replacement + text.slice(end);
          const previous = tree;
          let fresh: Tree | undefined;
          try {
            previous.edit(
              new Edit({
                startIndex: start,
                oldEndIndex: end,
                newEndIndex: start + replacement.length,
                startPosition: pointAt(text, start),
                oldEndPosition: pointAt(text, end),
                newEndPosition: pointAt(next, start + replacement.length),
              })
            );
            tree = parser.parse(next, previous)!;
            fresh = parser.parse(next)!;
            check(tree, next, name);
            check(fresh, next, name);
            expect(snapshot(tree.rootNode)).toEqual(snapshot(fresh.rootNode));
            expect(captures(query, tree)).toEqual(captures(query, fresh));
          } finally {
            fresh?.delete();
            previous.delete();
          }
          text = next;
        }
      } finally {
        tree.delete();
      }
      function check(current: Tree, sourceText: string, name: string): void {
        expect(current.rootNode.hasError, sourceText).toBe(false);
        const result = query.captures(current.rootNode);
        expect(result.filter(({ name }) => name === 'infix')).toHaveLength(0);
        const call = result.filter(({ name }) => name === 'call');
        expect(call).toHaveLength(1);
        expect(call[0]!.node.parent?.type).toBe(owner);
        const identifier = result.find(
          ({ name: capture, node }) => capture === 'identifier' && node.text === name
        )!.node;
        expect(identifier.parent?.id).toBe(call[0]!.node.id);
        expect(identifier.startIndex).toBe(sourceText.indexOf(name));
        expect(identifier.endIndex).toBe(identifier.startIndex + name.length);
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('retains get annotation targets through target and trivia edits', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(use_site_target) @target (annotation) @annotation');
  try {
    for (const sourceText of [
      'class C { @get:Rule var value = 1 }',
      'class C(@get:Rule var value: Int)',
      'class C { @get:[Rule Other] var value = 1 }',
    ]) {
      let text = sourceText;
      let tree = parser.parse(text)!;
      try {
        check(tree, text);
        for (const replacement of ['set /* target */ ', 'get']) {
          const start = text.indexOf('@') + 1;
          const end = text.indexOf(':', start);
          const next = text.slice(0, start) + replacement + text.slice(end);
          const previous = tree;
          let fresh: Tree | undefined;
          try {
            previous.edit(
              new Edit({
                startIndex: start,
                oldEndIndex: end,
                newEndIndex: start + replacement.length,
                startPosition: pointAt(text, start),
                oldEndPosition: pointAt(text, end),
                newEndPosition: pointAt(next, start + replacement.length),
              })
            );
            tree = parser.parse(next, previous)!;
            fresh = parser.parse(next)!;
            check(tree, next);
            check(fresh, next);
            expect(snapshot(tree.rootNode)).toEqual(snapshot(fresh.rootNode));
            expect(captures(query, tree)).toEqual(captures(query, fresh));
          } finally {
            fresh?.delete();
            previous.delete();
          }
          text = next;
        }
        expect(text).toBe(sourceText);
      } finally {
        tree.delete();
      }
      function check(current: Tree, sourceText: string): void {
        expect(current.rootNode.hasError, sourceText).toBe(false);
        const targets = query.captures(current.rootNode).filter(({ name }) => name === 'target');
        expect(targets).toHaveLength(1);
        expect(targets[0]!.node.parent?.type).toBe('annotation');
        expect(targets[0]!.node.startIndex).toBe(sourceText.indexOf('@') + 1);
        expect(targets[0]!.node.endIndex).toBe(sourceText.indexOf(':') + 1);
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('retains get labels and bare accessor boundaries through name and trivia edits', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(label) @label (getter) @getter');
  try {
    for (const [original, kind] of [
      ['fun f() { get@ for (i in 1..3) { println(i) } }', 'label'],
      ['fun f() { val x = get@ (1 + 2) }', 'label'],
      ['fun f() { get@ while (true) { break@get } }', 'label'],
      ['class C { val a = 1 get\nval b = 2 }', 'getter'],
      ['class C { val a = 1 get /* boundary */\nprivate val b = 2 }', 'getter'],
      ['class C { val a = 1 get // boundary\nfun <T> b(t: T) = t }', 'getter'],
      ['class C { val a = 1 get\nconstructor() {} }', 'getter'],
      ['class C { val a = 1 get\ninit {} }', 'getter'],
    ] as const) {
      let text: string = original;
      let tree = parser.parse(text)!;
      try {
        check(tree, text);
        for (const replacement of kind === 'label' ? ['longerLabel', 'get'] : ['get /* accessor */ ', 'get']) {
          const start = text.indexOf(
            kind === 'label' ? (text.includes('longerLabel@') ? 'longerLabel@' : 'get@') : 'get'
          );
          const end = kind === 'label' ? text.indexOf('@', start) : text.indexOf('\n', start);
          const next = text.slice(0, start) + replacement + text.slice(end);
          const previous = tree;
          let fresh: Tree | undefined;
          try {
            previous.edit(
              new Edit({
                startIndex: start,
                oldEndIndex: end,
                newEndIndex: start + replacement.length,
                startPosition: pointAt(text, start),
                oldEndPosition: pointAt(text, end),
                newEndPosition: pointAt(next, start + replacement.length),
              })
            );
            tree = parser.parse(next, previous)!;
            fresh = parser.parse(next)!;
            check(tree, next);
            check(fresh, next);
            expect(snapshot(tree.rootNode)).toEqual(snapshot(fresh.rootNode));
            expect(captures(query, tree)).toEqual(captures(query, fresh));
          } finally {
            fresh?.delete();
            previous.delete();
          }
          text = next;
        }
      } finally {
        tree.delete();
      }
      function check(current: Tree, sourceText: string): void {
        expect(current.rootNode.hasError, sourceText).toBe(false);
        const matching = query.captures(current.rootNode).filter(({ name }) => name === kind);
        expect(matching).toHaveLength(1);
        const node = matching[0]!.node;
        const start = sourceText.indexOf(
          kind === 'label' && sourceText.includes('longerLabel@') ? 'longerLabel@' : 'get'
        );
        expect(node.startIndex).toBe(start);
        expect(node.text).toBe(kind === 'label' ? sourceText.slice(start, sourceText.indexOf('@', start) + 1) : 'get');
        if (kind === 'getter') expect(node.parent?.type).toBe('property_declaration');
      }
    }
    for (const operand of [
      '3',
      'public',
      'fun() = 2',
      'fun String.() = length',
      'object {}',
      '@Label { 3 }',
      'constructor()',
    ]) {
      const text = `class C { val value = row get\n${operand} }`;
      const tree = parser.parse(text)!;
      try {
        expect(tree.rootNode.hasError, text).toBe(false);
        expect(tree.rootNode.descendantsOfType('getter')).toHaveLength(0);
        expect(tree.rootNode.descendantsOfType('infix_expression')).toHaveLength(1);
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
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
