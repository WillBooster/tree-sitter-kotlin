import path from 'node:path';

import { Language, Parser, type Point, type Tree } from '@willbooster/web-tree-sitter';
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

test('keeps get as the infix identifier after ordinary and trailing-lambda receivers', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser();
  let tree: Tree | undefined;
  try {
    parser.setLanguage(language);
    tree = parser.parse(source)!;
    expect(tree.rootNode.hasError).toBe(false);
    const infixes = tree.rootNode.descendantsOfType('infix_expression');
    expect(infixes.map((node) => node.text)).toEqual([
      'row.insert {\n        println("insert")\n    } get row.id',
      'row get 3',
    ]);
    expect(infixes.map((node) => node.namedChildren.map((child) => child.type))).toEqual([
      ['call_expression', 'identifier', 'navigation_expression'],
      ['identifier', 'identifier', 'number_literal'],
    ]);
    for (const infix of infixes) {
      const node = infix.namedChildren[1]!;
      expect(node.text).toBe('get');
      expect(node.startIndex).toBe(source.indexOf(' get ', infix.startIndex) + 1);
      expect(node.endIndex).toBe(node.startIndex + 3);
      expect(node.startPosition).toEqual(pointAt(source, node.startIndex));
      expect(node.endPosition).toEqual(pointAt(source, node.endIndex));
      expect(infix.startIndex).toBe(source.indexOf(infix.text));
      expect(infix.endIndex).toBe(infix.startIndex + infix.text.length);
    }
    expect(infixes[0]!.namedChildren[0]!.descendantsOfType('annotated_lambda')).toHaveLength(1);
    expect(tree.rootNode.descendantsOfType(['getter', 'setter'])).toHaveLength(0);
  } finally {
    tree?.delete();
    parser.delete();
  }
});

test('keeps infix get expressions with receivers and names of other lengths', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser();
  let text = source;
  try {
    parser.setLanguage(language);
    for (const [anchor, before, after, offset, expected] of [
      ['row get 3', 'row', 'longerReceiver', 0, 'longerReceiver get 3'],
      ['longerReceiver get 3', 'get', 'getValue', 15, 'longerReceiver getValue 3'],
      ['longerReceiver getValue 3', 'longerReceiver', 'r', 0, 'r getValue 3'],
      ['r getValue 3', 'getValue', 'get', 2, 'r get 3'],
      ['row.insert {', 'row', 'longerEntry', 0, 'longerEntry.insert {\n        println("insert")\n    } get row.id'],
    ] as const) {
      const anchorStart = text.indexOf(anchor);
      expect(anchorStart).toBeGreaterThanOrEqual(0);
      const start = anchorStart + offset;
      expect(text.slice(start, start + before.length)).toBe(before);
      text = text.slice(0, start) + after + text.slice(start + before.length);
      const tree = parser.parse(text)!;
      try {
        expect(tree.rootNode.hasError, text).toBe(false);
        expect(tree.rootNode.descendantsOfType('infix_expression').map((node) => node.text)).toContain(expected);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('retains getter ownership and incomplete member identifiers beside contextual get calls', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    for (const text of [
      'val p=1\n/* unfinished\n/*closed*/ get()=2',
      'fun f(){ val p=1\n/* unfinished\n/*closed*/ get()=2\n}',
      'class Foo{ val p=1\n/* unfinished\n/*closed*/ get()=2\n}',
      'class C { var p:Int=1\n get(/* parameter comment */)=field\n set(value){field=value} }',
    ]) {
      const tree = parser.parse(text)!;
      try {
        expect(tree.rootNode.hasError, text).toBe(false);
        const getters = tree.rootNode.descendantsOfType('getter');
        expect(getters).toHaveLength(1);
        const getter = getters[0]!;
        expect(getter.parent?.type).toBe('property_declaration');
        expect(getter.startIndex).toBe(text.indexOf('get('));
        expect(getter.text).toBe(text.includes('parameter comment') ? 'get(/* parameter comment */)=field' : 'get()=2');
        expect(getter.endIndex).toBe(getter.startIndex + getter.text.length);
        expect(tree.rootNode.descendantsOfType('setter').map((node) => node.text)).toEqual(
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
        expect(tree.rootNode.descendantsOfType('identifier').filter((node) => node.text === 'get')).toHaveLength(1);
        expect(tree.rootNode.descendantsOfType('property_declaration').map((node) => node.text)).toContain(
          'val p: Int'
        );
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('retains get call operands of return and throw with other names and trivia', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser().setLanguage(language);
  try {
    for (const [prefix, argumentsText, owner] of [
      ['return ', '(1)', 'return_expression'],
      ['return ', '(1, 2)', 'return_expression'],
      ['return ', '()', 'return_expression'],
      ['return@f ', '(1, 2)', 'return_expression'],
      ['throw ', '(1, 2)', 'throw_expression'],
    ] as const) {
      let text = `fun f() { ${prefix}get${argumentsText} }`;
      check(text, 'get');
      for (const name of ['getValue', 'get']) {
        const start = text.indexOf('get');
        const end = start + (text.startsWith('getValue', start) ? 'getValue'.length : 'get'.length);
        const replacement = `${name} /* call boundary */ `;
        const next = text.slice(0, start) + replacement + text.slice(end);
        check(next, name);
        text = next;
      }
      function check(sourceText: string, name: string): void {
        const current = parser.parse(sourceText)!;
        try {
          expect(current.rootNode.hasError, sourceText).toBe(false);
          expect(current.rootNode.descendantsOfType('infix_expression')).toHaveLength(0);
          const calls = current.rootNode.descendantsOfType('call_expression');
          expect(calls).toHaveLength(1);
          expect(calls[0]!.parent?.type).toBe(owner);
          const identifier = current.rootNode.descendantsOfType('identifier').find((node) => node.text === name)!;
          expect(identifier.parent?.id).toBe(calls[0]!.id);
          expect(identifier.startIndex).toBe(sourceText.indexOf(name));
          expect(identifier.endIndex).toBe(identifier.startIndex + name.length);
        } finally {
          current.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('retains get annotation targets with other targets and trivia', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser().setLanguage(language);
  try {
    for (const sourceText of [
      'class C { @get:Rule var value = 1 }',
      'class C(@get:Rule var value: Int)',
      'class C { @get:[Rule Other] var value = 1 }',
    ]) {
      let text = sourceText;
      check(text);
      for (const replacement of ['set /* target */ ', 'get']) {
        const start = text.indexOf('@') + 1;
        const end = text.indexOf(':', start);
        const next = text.slice(0, start) + replacement + text.slice(end);
        check(next);
        text = next;
      }
      expect(text).toBe(sourceText);
      function check(sourceText: string): void {
        const current = parser.parse(sourceText)!;
        try {
          expect(current.rootNode.hasError, sourceText).toBe(false);
          const targets = current.rootNode.descendantsOfType('use_site_target');
          expect(targets).toHaveLength(1);
          expect(targets[0]!.parent?.type).toBe('annotation');
          expect(targets[0]!.startIndex).toBe(sourceText.indexOf('@') + 1);
          expect(targets[0]!.endIndex).toBe(sourceText.indexOf(':') + 1);
        } finally {
          current.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('retains get labels and bare accessor boundaries with other names and trivia', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser().setLanguage(language);
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
      ['class C { val a = 1 get\ncompanion object {} }', 'getter'],
      ['class C { val a = 1 get\nprivate companion object {} }', 'getter'],
      ['class C { val a = 1 get /* boundary */\ncompanion /* member */ object : Any() {} }', 'getter'],
      ['class C { val a = 1 get\ncompanion object Named {} }', 'getter'],
      ['class C { val a = 1 get\n@Ann val x = 2 }', 'getter'],
      ['class C { val a = 1 get\n@Ann fun f() {} }', 'getter'],
      ['class C { val a = 1 get\n@Ann object O }', 'getter'],
      ['class C { val a = 1 get\n@A @B private val x = 2 }', 'getter'],
      ['class C { val a = 1 get\n@get:Ann val x = 2 }', 'getter'],
      ['class C { val a = 1 get\n@[A B] val x = 2 }', 'getter'],
      ['class C { val a = 1 get\n@pkg.Ann("val", ["fun"]) val x = 2 }', 'getter'],
      ['class C { val a = 1 get\n@`Ann` /* member */ val x = 2 }', 'getter'],
      ['class C { val a = 1 get\nprivate @Ann val x = 2 }', 'getter'],
      ['fun f() { val a = 1 get\nfor (i in 1..2) {} }', 'getter'],
      ['fun f() { val a = 1 get\nwhile (x) {} }', 'getter'],
      ['fun f() { val a = 1 get\ndo {} while (x) }', 'getter'],
      ['fun f() { val a = 1 get\nx = 1 }', 'getter'],
    ] as const) {
      let text: string = original;
      check(text);
      for (const replacement of kind === 'label' ? ['longerLabel', 'get'] : ['get /* accessor */ ', 'get']) {
        const start = text.indexOf(
          kind === 'label' ? (text.includes('longerLabel@') ? 'longerLabel@' : 'get@') : 'get'
        );
        const end = kind === 'label' ? text.indexOf('@', start) : text.indexOf('\n', start);
        const next = text.slice(0, start) + replacement + text.slice(end);
        check(next);
        text = next;
      }
      function check(sourceText: string): void {
        const current = parser.parse(sourceText)!;
        try {
          expect(current.rootNode.hasError, sourceText).toBe(false);
          const matching = current.rootNode.descendantsOfType(kind);
          expect(matching).toHaveLength(1);
          const node = matching[0]!;
          const start = sourceText.indexOf(
            kind === 'label' && sourceText.includes('longerLabel@') ? 'longerLabel@' : 'get'
          );
          expect(node.startIndex).toBe(start);
          expect(node.text).toBe(
            kind === 'label' ? sourceText.slice(start, sourceText.indexOf('@', start) + 1) : 'get'
          );
          if (kind === 'getter') expect(node.parent?.type).toBe('property_declaration');
          if (sourceText.includes('companion')) {
            const members = current.rootNode.descendantsOfType('companion_object');
            expect(members).toHaveLength(1);
            expect(members[0]!.parent?.type).toBe('class_body');
          }
        } finally {
          current.delete();
        }
      }
    }
    for (const operand of [
      '3',
      'public',
      'fun() = 2',
      'fun String.() = length',
      'object {}',
      'object : Any() {}',
      '@Label { 3 }',
      '@A @B { 3 }',
      '@Ann fun() = 2',
      '@Ann object : Any() {}',
      'constructor()',
      'x / 2',
      'x == 1',
      'foo("a=b")',
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
    parser.delete();
  }
});

test('retains newline infix ownership across equality operators', async () => {
  await Parser.init();
  const language = await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm'));
  const parser = new Parser().setLanguage(language);
  try {
    for (const context of ['class C', 'fun f()']) {
      let text = `${context} { val value = row get\nx !== 1 }`;
      check(text);
      for (const operator of ['!=', '===', '==', '!==']) {
        const start = text.indexOf('x ') + 2;
        const end = text.indexOf(' 1', start);
        const next = text.slice(0, start) + operator + text.slice(end);
        check(next);
        text = next;
      }
      function check(sourceText: string): void {
        const current = parser.parse(sourceText)!;
        try {
          expect(current.rootNode.hasError).toBe(false);
          expect(current.rootNode.descendantsOfType('getter')).toHaveLength(0);
          const infixes = current.rootNode.descendantsOfType('infix_expression');
          expect(infixes).toHaveLength(1);
          const infix = infixes[0]!;
          expect(infix.text).toBe('row get\nx');
          expect(infix.parent?.type).toBe('binary_expression');
          expect(infix.parent?.parent?.type).toBe('property_declaration');
          expect(infix.startIndex).toBe(sourceText.indexOf('row'));
          expect(infix.endIndex).toBe(sourceText.indexOf('x ') + 1);
        } finally {
          current.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

function pointAt(text: string, index: number): Point {
  const preceding = text.slice(0, index).split('\n');
  return { row: preceding.length - 1, column: preceding.at(-1)!.length };
}
