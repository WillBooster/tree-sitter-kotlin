import fs from 'node:fs';
import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { generationInputMtime } from '../helpers/generationInputs.js';

const Root = path.join(import.meta.dirname, '../..');
// The Wasm build is the one the package ships.
const WasmPath = path.join(Root, 'tree-sitter-kotlin.wasm');
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(WasmPath));

// The tests load the existing Wasm build, so a check against a stale one would miss an edit that restores the slowdown.
test('uses a Wasm build built from the current parser', () => {
  const sources = ['grammar.js', 'src/parser.c', 'src/scanner.c', 'src/tree_sitter/parser.h'].map(
    (name) => fs.statSync(path.join(Root, name)).mtimeMs
  );
  expect(
    Math.max(generationInputMtime(Root), ...sources) > fs.statSync(WasmPath).mtimeMs,
    'generation inputs or src/ changed after the Wasm build was built; run `bun run build/ci`'
  ).toBe(false);
});

// Consumers parse files being edited, so recovering from many errors must stay linear: ten times the lines take about
// ten times as long, against a hundred times for quadratic recovery. The ratio catches a cost that grows faster than
// the input even on a slow CI runner; it would pass a parser that is uniformly slower, so the larger parse also has a
// generous ceiling, about 35 times the 0.15 s of CPU time it takes here. The parses are timed in the CPU time of the
// thread that runs them: wall-clock time is inflated unevenly by the test files running alongside, and the process's
// CPU time also counts the engine's background threads, which compile the Wasm build and collect garbage during the
// parses. With process CPU time, the ratio of 1,000 to 10,000 lines ranged from 7 to 25 locally, and that of 2,000 to
// 20,000 lines reached 24 on a CI runner. With thread CPU time, 2,000 and 20,000 lines measured after warm-up parses
// and in alternation, each keeping its fastest run, give 9.8 to 11.7 locally; 18 leaves a margin over that and fails
// for growth faster than about n^1.25.
test('recovers from an error on each line in linear time', { timeout: 60_000 }, () => {
  const small = '$ a\n'.repeat(2000);
  const large = '$ a\n'.repeat(20_000);
  parseCpuTime(large);
  parseCpuTime(large);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 5; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small));
    largeFastest = Math.min(largeFastest, parseCpuTime(large));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
  // process.threadCpuUsage reports microseconds.
  expect(largeFastest).toBeLessThan(5_000_000);
});

test('recovers from repeated unfinished destructuring types in linear time', { timeout: 60_000 }, () => {
  const small = `fun f() {\n${'  xs.map { (a, b):\n  println(i\n'.repeat(500)}}\n`;
  const large = `fun f() {\n${'  xs.map { (a, b):\n  println(i\n'.repeat(5000)}}\n`;
  parseCpuTime(large);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 3; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small));
    largeFastest = Math.min(largeFastest, parseCpuTime(large));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
  expect(largeFastest).toBeLessThan(5_000_000);
});

test('recovers from repeated trailing-dot imports with comments in linear time', { timeout: 60_000 }, () => {
  const small = 'import a.\n/* next */ import b.c\n'.repeat(2000);
  const large = 'import a.\n/* next */ import b.c\n'.repeat(20_000);
  parseCpuTime(large);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 3; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small));
    largeFastest = Math.min(largeFastest, parseCpuTime(large));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
  expect(largeFastest).toBeLessThan(5_000_000);
});

test('parses repeated unterminated block comments in linear time', { timeout: 60_000 }, () => {
  const small = `fun f() {\n${'  if (a) b\n  else /* x\n'.repeat(2000)}}\n`;
  const large = `fun f() {\n${'  if (a) b\n  else /* x\n'.repeat(20_000)}}\n`;
  // A single parse can be shorter than the runner's thread CPU clock resolution.
  const repetitions = 100;
  parseCpuTime(large, repetitions);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 3; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small, repetitions));
    largeFastest = Math.min(largeFastest, parseCpuTime(large, repetitions));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
  expect(largeFastest / repetitions).toBeLessThan(5_000_000);
});

// A `/*` in an annotation's string is no comment, so the lookahead for a constructor or an accessor after the
// annotation must not scan it to the end of the input at every such annotation.
test('parses comment openers in annotation strings in linear time', { timeout: 60_000 }, () => {
  const unit = 'class X\n@A("a /* b")\nfun f() {}\nobject O {\n  val x: Int\n    @A("a) /* b")\n    get() = 1\n}\n$\n';
  const small = unit.repeat(1000);
  const large = unit.repeat(10_000);
  parseCpuTime(large);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 3; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small));
    largeFastest = Math.min(largeFastest, parseCpuTime(large));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
  expect(largeFastest).toBeLessThan(5_000_000);
});

const ifChainCases = [
  ['in a function', 250],
  ['in a when entry', 250],
  ['past the scanner frame limit', 250],
  ['with function casts', 150],
  ['with casts of call results', 150],
  ['with generic receivers and conditional alternatives', 150],
  ['with nested if branches in conditions', 150],
  ['with statement blocks inside when entries', 150],
  ['with type prefixes on casts', 150],
  ['with nested alternatives past the scanner frame limit', 40],
  ['with nested when bodies', 40],
  ['with nested when conditions', 40],
  ['with nested parenthesized alternatives', 40],
  ['with deeply interpolated conditions', 40],
  ['with deeply interpolated bodies', 40],
  ['with long comments in conditions', 20],
] as const;

test.each(ifChainCases)(
  'parses unfinished nested if chains with explicit semicolons in linear time %s',
  { timeout: 60_000 },
  (context, depth) => {
    const small = unfinishedIfChain(depth, context);
    const large = unfinishedIfChain(depth * 10, context);
    const repetitions = 8;
    parseCpuTime(large, repetitions);
    let smallFastest = Infinity;
    let largeFastest = Infinity;
    for (let run = 0; run < 3; run++) {
      smallFastest = Math.min(smallFastest, parseCpuTime(small, repetitions));
      largeFastest = Math.min(largeFastest, parseCpuTime(large, repetitions));
    }
    expect(largeFastest / smallFastest).toBeLessThan(20);
  }
);

function unfinishedIfChain(depth: number, context: (typeof ifChainCases)[number][0]): string {
  const body = `${'if (a) '.repeat(depth)}f()`;
  const alternatives = '; else if (a) g() else h()'.repeat(depth / 2);
  const cast = castBody(context);
  if (cast) {
    const casts = `; else if (a) ${cast}`.repeat(depth / 2);
    return `fun f(a: Boolean, fn: (Int) -> Any) { when (0) { 0 -> ${body}${casts}\nelse -> Unit }`;
  }
  if (context === 'with nested when bodies') {
    const prefix = 'when (0) { 0 -> if (a) f(); else if (a) '.repeat(depth);
    const suffix = '\nelse -> Unit }'.repeat(depth);
    return `fun f(a: Boolean) { ${prefix}f()${suffix}`;
  }
  if (context === 'with nested alternatives past the scanner frame limit') {
    const scopes = 'if (a) {'.repeat(256);
    const prefixes = 'if (a) f(); else if (a) {'.repeat(depth);
    const suffixes = '} else f()\n'.repeat(depth);
    return `fun f(a: Boolean) { ${scopes}${prefixes}f()${suffixes}${'}'.repeat(256)}`;
  }
  if (context === 'with nested parenthesized alternatives') {
    const prefix = 'if (a) f(); else if (a) ('.repeat(depth);
    const suffix = ') else f()'.repeat(depth);
    return `fun f(a: Boolean) { when (0) { 0 -> ${prefix}f()${suffix}\nelse -> Unit }`;
  }
  if (context === 'with nested when conditions') {
    const prefix = 'when (0) { 0 -> if (a) f(); else if (when (0) { 0 -> '.repeat(depth);
    const suffix = '}) f()\nelse -> Unit }'.repeat(depth);
    return `fun f(a: Boolean) { ${prefix}f()${suffix}`;
  }
  const branch = alternativeWithNestedTokens(context);
  if (branch) return `fun f(a: Boolean) { when (0) { 0 -> ${body}${branch.repeat(depth / 2)}\nelse -> Unit }`;
  if (context === 'in a when entry')
    return `fun f(a: Boolean) { when (0) { 0 -> ${body}${alternatives}\nelse -> Unit }`;
  if (context === 'past the scanner frame limit')
    return `fun f(a: Boolean) { ${'if (a) {'.repeat(256)}${body}${alternatives}${'}'.repeat(256)}`;
  return `fun f(a: Boolean) { ${body}${'; else g()'.repeat(depth / 2)}`;
}

function castBody(context: (typeof ifChainCases)[number][0]): string | undefined {
  if (context === 'with function casts') return 'fn as (Int) -> Int else fn';
  if (context === 'with casts of call results') return '(fn(0)) as? (Int) -> Int';
  if (context === 'with type prefixes on casts') return 'fn(0) as @Ann(1) context(String) (Int) -> Int else h()';
  if (context === 'with generic receivers and conditional alternatives')
    return 'fn(0) as Map<Int, List<Int>>.() -> Int else if (a) g() else h()';
}

function alternativeWithNestedTokens(context: (typeof ifChainCases)[number][0]): string | undefined {
  if (context === 'with statement blocks inside when entries')
    return '; else if (when (0) { else -> { if (a) f(); else if (a) g(); true } }) g() else h()';
  if (context === 'with nested if branches in conditions')
    return '; else if (if (a) true; /* branch */ else if (a) false else true) g() else h()';
  if (context === 'with deeply interpolated conditions')
    return `; else if ((${nestedTemplate(32)}).isNotEmpty()) g() else h()`;
  if (context === 'with deeply interpolated bodies') return `; else if (a) g(${nestedTemplate(32)}) else h()`;
  if (context === 'with long comments in conditions')
    return `; else if (/* ${'a '.repeat(2250)}*/ a) /* ${'a '.repeat(2250)}*/ g() else h()`;
}

function nestedTemplate(depth: number): string {
  let text = '"x"';
  for (let index = 0; index < depth; index++) text = '"${' + text + '}"';
  return text;
}

function parseCpuTime(source: string, repetitions = 1): number {
  const trees = [];
  const start = process.threadCpuUsage();
  for (let i = 0; i < repetitions; i++) {
    trees.push(parser.parse(source));
  }
  const { system, user } = process.threadCpuUsage(start);
  for (const tree of trees) {
    if (!tree) throw new Error('The parser returned no tree');
    const { hasError } = tree.rootNode;
    tree.delete();
    expect(hasError).toBe(true);
  }
  return system + user;
}
