import path from 'node:path';

import { Edit, Language, Parser, Query, type Node, type Tree } from '@willbooster/web-tree-sitter';
import { beforeAll, expect, test } from 'vitest';

let language: Language;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
});

test('keeps catch and finally blocks attached across newlines and edits', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(catch_block) @catch (finally_block) @finally');
  const first = 'catch (first: IllegalArgumentException) { println(first) }';
  const second = 'catch (second: RuntimeException) { println(second) }';
  const final = 'finally { println("done") }';
  try {
    for (const separator of [' ', '\n', '\r\n', '\n/* outer /* nested */ */\n', '\n// handler\n']) {
      const source = `fun f() { try { error("x") } ${first}${separator}${second}${separator}${final}\n println("after") }`;
      const tree = parser.parse(source)!;
      let edited: Tree | undefined;
      let fresh: Tree | undefined;
      try {
        check(tree, source);
        const start = source.indexOf(second);
        const insertion = '\n/* edited boundary */\n';
        const changed = source.slice(0, start) + insertion + source.slice(start);
        tree.edit(
          new Edit({
            startIndex: start,
            oldEndIndex: start,
            newEndIndex: start + insertion.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start),
            newEndPosition: position(changed, start + insertion.length),
          })
        );
        edited = parser.parse(changed, tree)!;
        fresh = parser.parse(changed)!;
        check(edited, changed);
        check(fresh, changed);
        expect(snapshot(edited.rootNode)).toEqual(snapshot(fresh.rootNode));
      } finally {
        fresh?.delete();
        edited?.delete();
        tree.delete();
      }
    }

    function check(tree: Tree, source: string): void {
      expect(tree.rootNode.hasError, source).toBe(false);
      const tries = tree.rootNode.descendantsOfType('try_expression');
      expect(tries).toHaveLength(1);
      expect(
        tries[0]!.namedChildren
          .map((node) => node.type)
          .filter((type) => type === 'catch_block' || type === 'finally_block')
      ).toEqual(['catch_block', 'catch_block', 'finally_block']);
      expect(
        query.captures(tree.rootNode).map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
      ).toEqual(
        [first, second, final].map((text, index) => [
          index === 2 ? 'finally' : 'catch',
          text,
          source.indexOf(text),
          source.indexOf(text) + text.length,
        ])
      );
      expect(tree.rootNode.descendantsOfType('call_expression').at(-1)?.text).toBe('println("after")');
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

function position(source: string, index: number): { row: number; column: number } {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1)!.length };
}

function snapshot(node: Node): unknown {
  return {
    type: node.type,
    named: node.isNamed,
    missing: node.isMissing,
    error: node.isError,
    hasError: node.hasError,
    extra: node.isExtra,
    start: node.startIndex,
    end: node.endIndex,
    startPosition: node.startPosition,
    endPosition: node.endPosition,
    children: node.children.map((child, index) => ({ field: node.fieldNameForChild(index), node: snapshot(child) })),
  };
}

test('retains standalone finally expressions and keyword-prefixed calls', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(call_expression) @call');
  try {
    for (const calls of [
      ['println(1)', 'finally {}'],
      ['catcher()', 'catch_value()', 'finallyDone()', 'finally_value()', '`catch`()', '`finally`()'],
    ]) {
      const source = `fun f() { ${calls.join('\n')} }`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(
          query.captures(tree.rootNode).map(({ node }) => node.text),
          source
        ).toEqual(calls);
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('keeps non-handler catch and finally expressions after a completed try', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(try_expression) @try (catch_block) @catch (finally_block) @finally');
  const completeTry = 'try {} catch(e: Exception) {}';
  try {
    for (const expression of [
      'finally()',
      'finally + 1',
      'finally.value',
      'finally[0]',
      'finally = 1',
      'finally?.value',
      'finally as Any',
      'finally is Any',
      'catch()',
      'catch + 1',
      'catch.value',
      'catch[0]',
      'catch = 1',
      'catch(@param:A e)',
      'catch(::foo)',
      'catch(a::foo)',
      'catch(A::class)',
      'catch((::foo))',
      'catch(a ?: b)',
      'catch(a?:b)',
    ]) {
      const source = `fun f() { ${completeTry}\n${expression}\nprintln(1) }`;
      const tree = parser.parse(source)!;
      let edited: Tree | undefined;
      let fresh: Tree | undefined;
      try {
        check(tree);
        const start = source.indexOf(expression);
        const insertion = '\n/* boundary */\n';
        const changed = source.slice(0, start) + insertion + source.slice(start);
        tree.edit(
          new Edit({
            startIndex: start,
            oldEndIndex: start,
            newEndIndex: start + insertion.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start),
            newEndPosition: position(changed, start + insertion.length),
          })
        );
        edited = parser.parse(changed, tree)!;
        fresh = parser.parse(changed)!;
        check(edited);
        check(fresh);
        expect(snapshot(edited.rootNode)).toEqual(snapshot(fresh.rootNode));
      } finally {
        fresh?.delete();
        edited?.delete();
        tree.delete();
      }
      function check(current: Tree): void {
        expect(current.rootNode.hasError, source).toBe(false);
        expect(query.captures(current.rootNode).map(({ name, node }) => [name, node.text])).toEqual([
          ['try', completeTry],
          ['catch', 'catch(e: Exception) {}'],
        ]);
        expect(
          current.rootNode
            .descendantsOfType('block')[0]!
            .namedChildren.filter((node) => !node.isExtra)
            .map((node) => node.text)
        ).toEqual([completeTry, expression, 'println(1)']);
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('retains whole catch-prefixed names in malformed member lists', () => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(identifier) @identifier');
  try {
    for (const name of ['catcher', 'catch_value', 'catch1']) {
      const source = `class C { val x = println(1)\n${name}() }`;
      const tree = parser.parse(source)!;
      let edited: Tree | undefined;
      let fresh: Tree | undefined;
      try {
        check(tree, source);
        const start = source.indexOf(name);
        const insertion = '\n/* member boundary */\n';
        const changed = source.slice(0, start) + insertion + source.slice(start);
        tree.edit(
          new Edit({
            startIndex: start,
            oldEndIndex: start,
            newEndIndex: start + insertion.length,
            startPosition: position(source, start),
            oldEndPosition: position(source, start),
            newEndPosition: position(changed, start + insertion.length),
          })
        );
        edited = parser.parse(changed, tree)!;
        fresh = parser.parse(changed)!;
        check(edited, changed);
        check(fresh, changed);
        expect(snapshot(edited.rootNode)).toEqual(snapshot(fresh.rootNode));
      } finally {
        fresh?.delete();
        edited?.delete();
        tree.delete();
      }
      function check(current: Tree, text: string): void {
        expect(current.rootNode.hasError).toBe(true);
        expect(
          query
            .captures(current.rootNode)
            .filter(({ node }) => node.text === name)
            .map(({ node }) => [node.text, node.startIndex, node.endIndex])
        ).toEqual([[name, text.indexOf(name), text.indexOf(name) + name.length]]);
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});
