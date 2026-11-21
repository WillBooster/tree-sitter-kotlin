import path from 'node:path';

import { Language, type Node, Parser } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, expect, test } from 'vitest';

let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  parser.setLanguage(await Language.load(path.join(import.meta.dirname, '../../tree-sitter-kotlin.wasm')));
});

afterAll(() => {
  parser.delete();
});

test('separates same-line class members, including nested members', () => {
  const members = ['fun first() {}', 'class Nested { fun inner() {} fun last() {} }', 'fun final() {}'];
  const expected = [members[0], members[1], 'fun inner() {}', 'fun last() {}', members[2]];
  for (const separator of [' ', '; ', '\n']) {
    const tree = parser.parse(`class C { ${members.join(separator)} }`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(classMembers(tree.rootNode).map((node) => node.text)).toEqual(expected);
    } finally {
      tree.delete();
    }
  }
});

test('preserves literal semicolon spans inside property initializers', () => {
  const source = `class C {
    val x: Int = if (true) 1; else 2
    var y: Int = if (true) 1; /* note */ else 2; get() = field; set(value) { field = value }
  }`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const semicolons = tree.rootNode
      .descendantsOfType('if_expression')
      .map((node) => node?.children.find((child) => child?.type === ';'));
    expect(semicolons.map((node) => node?.text)).toEqual([';', ';']);
    expect(semicolons.map((node) => node?.startIndex)).toEqual([source.indexOf(';'), source.indexOf('; /* note */')]);
  } finally {
    tree.delete();
  }
});

test.each([
  'class C { fun f() = if (a) 1; else 2 }',
  'interface C { fun f() = if (a) 1; /* note */ else 2 }',
  'object C { fun f() = g(if (a) 1; else 2) }',
  'class C { companion object { fun f() = if (a) 1; else 2 } }',
  'class C { fun f(x: Int = if (a) 1; else 2) {} }',
  'class C { constructor(x: Int = if (a) 1; else 2) {} }',
])('finishes a pending else before checking member boundaries in %s', (source) => {
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const [conditional] = tree.rootNode.descendantsOfType('if_expression');
    expect(conditional?.childForFieldName('alternative')?.text).toBe('2');
    const semicolon = conditional?.children.find((child) => child.type === ';');
    expect(semicolon?.startIndex).toBe(source.indexOf(';'));
  } finally {
    tree.delete();
  }
});

test('ends a when body at its semicolon before fallback trivia', () => {
  const body = 'if (a) while (a);';
  const source = `class C { fun f(a: Boolean, n: Int) {
    when (n) {
      1 -> ${body} /* after body */
      else -> Unit
    }
  } }`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const [first, fallback] = tree.rootNode.descendantsOfType('when_entry');
    expect(first?.childForFieldName('body')?.text).toBe(body);
    expect(fallback?.startIndex).toBe(source.indexOf('else'));
  } finally {
    tree.delete();
  }
});

test.each(['if (p);', 'if (p) while (p);', 'if (p) for (x in xs);', 'if (p) if (q) println(1) else;'])(
  'keeps the empty body semicolon in %s with either else owner',
  (body) => {
    const head = `fun f(p: Boolean, q: Boolean, n: Int, xs: List<Int>) {
    when (n) { 1 -> ${body} /* boundary */`;
    const guard = '(when (n) { 0 -> if (p) true; else if (p) false else true\nelse -> false })';
    const tree = parser.parse(`${head} else if ${guard} -> Unit\nelse -> Unit } }`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const [first, fallback] = tree.rootNode.descendantsOfType('when_entry');
      expect(first?.childForFieldName('body')?.text).toBe(body);
      expect(fallback?.childForFieldName('guard')?.text).toBe(guard);
    } finally {
      tree.delete();
    }
    const alternative = 'else if (q) println(2)';
    const conditional = parser.parse(`${head} ${alternative}\n2 -> Unit\nelse -> Unit } }`)!;
    try {
      expect(conditional.rootNode.hasError).toBe(false);
      const [first, next] = conditional.rootNode.descendantsOfType('when_entry');
      expect(first?.childForFieldName('body')?.text).toContain(alternative);
      expect(next?.text).toBe('2 -> Unit');
    } finally {
      conditional.delete();
    }
  }
);

test.each([
  ['f()', 'else -> g()'],
  ['{ f() }', 'else -> g()'],
  ['f()', 'else if (p) -> g()'],
  ['{ f() }', 'else if (p) -> g()'],
])('keeps the when entry separator out of the body with %s and %s', (body, fallback) => {
  const source = `fun f(p: Boolean, n: Int) {
    when (n) { 1 -> if (p) ${body}; /* next entry */ ${fallback} }
  }`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const [first, next] = tree.rootNode.descendantsOfType('when_entry');
    const value = first?.childForFieldName('body');
    expect(value?.text).toBe(`if (p) ${body}`);
    expect(value?.endIndex).toBe(source.indexOf(';'));
    expect(next?.text).toBe(fallback);
  } finally {
    tree.delete();
  }
});

test('keeps an ordinary else-if when its nested condition yields to another probe', () => {
  const tree = parser.parse(`fun f(p: Boolean, n: Int) {
    when (n) {
        1 -> if (p) true; else if (when (n) {
            0 -> if (p) true; else if (p) false else true
            else -> false
        }) true else false
        else -> Unit
    }
}`)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const [entry] = tree.rootNode.descendantsOfType('when_entry');
    expect(entry?.childForFieldName('body')?.childForFieldName('alternative')?.type).toBe('if_expression');
  } finally {
    tree.delete();
  }
});

test.each([
  ['println(2)', '2'],
  ['42', '2'],
  ['0x2a', 'n'],
  ['1_000', '2, 3'],
  ['42L', '2, 3'],
  ['.5', '2'],
  ['.25f', '2, 3'],
  ['.1e-2', 'is String'],
  ['n', '2'],
  ['x to y', '2'],
  ['x to y', 'is String'],
  ['x until y', '"other"'],
  ['c!!', '2, 3'],
  ['x++', '2'],
  ['again@ do {} while (p)', '2'],
  ['again@ do { if (!p) break@again } while (p)', '2, 3'],
  ['again@ while (p) continue@again', 'is String'],
  ['y--', 'in 2..3'],
  ['n as () -> Boolean', '2'],
  ['n as (Boolean) -> Boolean', '2, 3'],
  ['n as (Boolean) -> List<Boolean>?', 'is String'],
  ['n as String.() -> () -> Boolean', '"other"'],
  ['@Ann n', '2'],
  ['@Ann(1) n', '2, 3'],
  ['+@Ann n', '2'],
  ['-@Ann(1) n', '2, 3'],
  ['!@Ann p', 'is String'],
  ['n as () -> @Ann Boolean', '2'],
  ['n as () -> @Ann(1) Boolean', '2, 3'],
  ['n as () -> @Ann (1) Boolean', '2'],
  ['n as () -> @Ann() (Boolean) -> Boolean', 'is String'],
  ['n as () -> @Ann (Boolean) -> Boolean', '"other"'],
  ['@example.Ann("argument") c!!', 'is String'],
])('keeps an ordinary else-if body %s before another when entry (%s)', (alternative, condition) => {
  const body = `if (p) println(1); else if (q) ${alternative}`;
  for (const depth of [0, 256]) {
    const tree = parser.parse(`fun f(p: Boolean, q: Boolean, n: Any, c: String?) {
      var x = 1
      var y = 2
      ${'if (p) { '.repeat(depth)}
      when (n) {
        1 -> ${body}
        ${condition} -> Unit
        else -> Unit
      }
      ${'}'.repeat(depth)}
    }`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const [first, next] = tree.rootNode.descendantsOfType('when_entry');
      expect(first?.childForFieldName('body')?.text).toBe(body);
      expect(next?.text).toBe(`${condition} -> Unit`);
    } finally {
      tree.delete();
    }
  }
});

test.each([
  'n ?: return@work false',
  'n ?: return@work (false)',
  'n ?: return@work q',
  'n ?: return@work',
  'n ?: return',
  'n ?: continue@again',
  'n ?: break',
])('preserves ordinary alternatives ending in the jump %s', (body) => {
  const source = `fun f(p: Boolean, q: Boolean, n: Int?) {
    again@ while (p) {
      run work@ {
        when (n) {
          1 -> if (p) println(n); else if (q) ${body}
          2 -> Unit
          else -> Unit
        }
      }
    }
  }`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const [first, next] = tree.rootNode.descendantsOfType('when_entry');
    expect(first?.childForFieldName('body')?.childForFieldName('alternative')?.text).toBe(`if (q) ${body}`);
    expect(next?.text).toBe('2 -> Unit');
  } finally {
    tree.delete();
  }
});

test.each([
  [2, 'n', '3'],
  [3, 'n', '3'],
  [2, 'items[0]!!', '!is String'],
  [3, '(items[0])!!', '!is String?'],
  [3, 'items[0]!!', '!in 0..3'],
])('binds a shared else to the innermost of %i pending conditionals before %s and %s', (depth, body, condition) => {
  const source = `fun f(a: Boolean, c: Boolean, n: Any, items: List<Int?>) {
    when (n) {
      1 -> ${'if (a) '.repeat(depth)}println(n); else if (c) ${body}
      ${condition} -> Unit
      else -> Unit
    }
  }`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const [first, next] = tree.rootNode.descendantsOfType('when_entry');
    let inner = first?.childForFieldName('body');
    for (let index = 1; index < depth; index++) {
      expect(inner?.childForFieldName('alternative')).toBeNull();
      inner = inner?.childForFieldName('consequence');
    }
    expect(inner?.childForFieldName('alternative')?.text).toBe(`if (c) ${body}`);
    expect(next?.text).toBe(`${condition} -> Unit`);
  } finally {
    tree.delete();
  }
});

test('a guarded when entry owns the literal even when initial lookahead is ambiguous', () => {
  const inner = `when (n) {
    0 -> if (p) true; else if (p) false else true
    else -> false
  }`;
  const guards = [`(${inner})`, `("\${${inner}}").isNotEmpty()`, `($$"""$\${${inner}}""").isNotEmpty()`, 'p is (Int)'];
  for (const guard of guards) {
    const source = `fun f(p: Boolean, n: Int) {
      when (n) {
        1 -> if (p) true; /* next entry */ else if ${guard} -> Unit
        else -> Unit
      }
    }`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const [first, next] = tree.rootNode.descendantsOfType('when_entry');
      expect(first?.childForFieldName('body')?.text).toBe('if (p) true');
      expect(first?.childForFieldName('body')?.endIndex).toBe(source.indexOf(';'));
      expect(next?.childForFieldName('guard')?.text).toBe(guard);
    } finally {
      tree.delete();
    }
  }
});

test.each([0, 256])('keeps multiline infix guards at %i enclosing blocks', (depth) => {
  const wrappers = 'if (p) { '.repeat(depth);
  const guards = [
    '(p) xor run { true } xor\n q',
    '(p) xor { true } xor\n (q)',
    '(n) xor 42L xor\n n',
    '(n) xor 0x2a xor\n n',
    '(n) xor 4.2F xor\n n',
    '(p) xor f() `xor`\n q',
    '(p) xor run { true } `xor`\n q',
    '(p) xor foo as Comparable<Boolean> xor\n q',
    '(n) xor f() as Map<Int, List<Int>>? `xor`\n n',
  ];
  for (const guard of guards) {
    const tree = parser.parse(`fun f(p: Boolean, q: Boolean, n: Int) { ${wrappers}
      when (n) { 1 -> if (p) f(); else if ${guard} -> Unit
        else -> Unit }
      ${'}'.repeat(depth)}
    }`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const [first, guarded] = tree.rootNode.descendantsOfType('when_entry');
      expect(first?.childForFieldName('body')?.text).toBe('if (p) f()');
      expect(guarded?.childForFieldName('guard')?.text).toBe(guard);
    } finally {
      tree.delete();
    }
  }
});

test('preserves guarded when entries across nested templates and conditional bodies', () => {
  let template = '"x"';
  for (let depth = 0; depth < 32; depth++) template = '"${' + template + '}"';
  for (const guard of [
    `(${template}).isNotEmpty()`,
    'if (p) { n > 0 }; /* before else */ else { n < 0 }',
    '(p) xor (n == 0)',
    'p as (Boolean)',
    'p is (Int) -> Int',
    '(p)!! as (Boolean)',
    '(n) !is (Int)',
    '(n) / 2 is (Int)',
    '(n) - if (p) 1; else if (p) 2 else 3 in 0..5',
    '(n) + if (p) 1; else if (p) 2 else 3 in 0..5',
    '(n)++ is (Int)',
    '(n)-- is (Int)',
  ]) {
    const tree = parser.parse(`fun f(p: Boolean, n: Int) {
      when (n) {
        1 -> if (p) println(n); else if ${guard} -> println(-n)
        else -> Unit
      }
    }`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const [, guarded] = tree.rootNode.descendantsOfType('when_entry');
      expect(guarded?.childForFieldName('guard')?.text).toBe(guard);
    } finally {
      tree.delete();
    }
  }
});

test('requires a separator after properties even when nested bodies contain adjacent functions', () => {
  for (const source of [
    'class C { fun first() {} val x = 1 val y = 2 }',
    'class C { val x = object { fun first() {} fun last() {} } fun next() {} }',
  ]) {
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
    } finally {
      tree.delete();
    }
  }
});

test('preserves adjacent contextual members', () => {
  for (const members of [
    ['init {}', 'init {}', 'fun f() {}'],
    ['constructor() {}', 'constructor(x: Int) {}', 'fun f() {}'],
    ['fun f() {}', 'companion object {}'],
    ['fun f() {}', 'private constructor() {}'],
    ['fun f() {}', 'private /* outer /* nested */ */ constructor() {}'],
  ]) {
    for (const separator of [' ', ' /* boundary */ ', '\n', '; ']) {
      const source = `class C { ${members.join(separator)} }`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(
          classMembers(tree.rootNode).map((node) => node.text),
          source
        ).toEqual(members);
      } finally {
        tree.delete();
      }
    }
  }
});

test('keeps first accessors attached across long comments and annotation arguments', () => {
  const description = 'A property description; '.repeat(250);
  const source = `class Properties {
    var fieldValue = 0; /* ${description} */ get() = field
    var otherValue = 0; @Deprecated("${description}") set(value) { field = value }
  }`;
  const tree = parser.parse(source)!;
  try {
    const members = classMembers(tree.rootNode);
    expect(tree.rootNode.hasError).toBe(false);
    expect(members.map((member) => member.lastNamedChild?.type)).toEqual(['getter', 'setter']);
  } finally {
    tree.delete();
  }
});

test('keeps contextual infix calls inside member expressions', () => {
  for (const expression of ['1 init {}', '1 companion object {}']) {
    const source = `class C { val x = ${expression}; fun f() = ${expression} }`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      expect(classMembers(tree.rootNode).map((node) => node.type)).toEqual([
        'property_declaration',
        'function_declaration',
      ]);
      expect(tree.rootNode.descendantsOfType('infix_expression').map((node) => node.text)).toEqual([
        expression,
        expression,
      ]);
    } finally {
      tree.delete();
    }
  }
});

test('keeps nested primary constructors attached to their class header', () => {
  for (const modifier of ['', 'private ', '@Ann ']) {
    const member = `class Nested ${modifier}constructor(val x: Int) { companion object {} }`;
    const tree = parser.parse(`class Outer { ${member} }`)!;
    try {
      expect(tree.rootNode.hasError, member).toBe(false);
      expect(classMembers(tree.rootNode).map((node) => node.text)).toEqual([member, 'companion object {}']);
      expect(tree.rootNode.descendantsOfType('primary_constructor')).toHaveLength(1);
      expect(tree.rootNode.descendantsOfType('secondary_constructor')).toHaveLength(0);
    } finally {
      tree.delete();
    }
  }
});

test('retains contextual companion object names and bodies', () => {
  for (const name of ['init', 'constructor', 'companion']) {
    for (const body of ['', ' {}']) {
      const member = `companion object ${name}${body}`;
      const tree = parser.parse(`class C { fun f() {} ${member} }`)!;
      try {
        expect(tree.rootNode.hasError, member).toBe(false);
        expect(classMembers(tree.rootNode).map((node) => node.text)).toEqual(['fun f() {}', member]);
        expect(tree.rootNode.descendantsOfType('companion_object')[0]?.childForFieldName('name')?.text).toBe(name);
      } finally {
        tree.delete();
      }
    }
  }
});

test('keeps annotated same-line members separate', () => {
  const first = 'fun first() {}';
  for (const second of [
    '@Ann fun second() {}',
    '@Ann fun (Int).second() {}',
    '@Ann fun (Int)?.second() {}',
    '@Ann fun (Int) ? /* bound */ .second() {}',
    '@Ann fun ((Int) -> Int)?.second() {}',
    '@Ann fun ((Int) -> Int).second() {}',
    '@Ann fun List<() -> Unit>.second() {}',
    '@Ann fun `name(with_paren`() {}',
    '@Ann(")") private fun second() {}',
    '@pkg.Ann @Other fun second() {}',
    '@[First Second("]")] fun second() {}',
    '@Ann /* outer /* inner */ */ constructor() {}',
    '@Ann companion object {}',
    '@Ann class Nested {}',
    '@Ann object Named {}',
    '@Ann object `named()` {}',
  ]) {
    const source = `class C { ${first} ${second} }`;
    const insertion = '@Added ';
    const start = source.indexOf(second);
    const changed = source.slice(0, start) + insertion + source.slice(start);
    const tree = parser.parse(source)!;
    const changedTree = parser.parse(changed)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(false);
      expect(
        classMembers(tree.rootNode).map((node) => node.text),
        source
      ).toEqual([first, second]);
      expect(changedTree.rootNode.hasError, changed).toBe(false);
      expect(classMembers(changedTree.rootNode).map((node) => [node.text, node.startIndex, node.endIndex])).toEqual([
        [first, source.indexOf(first), source.indexOf(first) + first.length],
        [insertion + second, start, start + insertion.length + second.length],
      ]);
    } finally {
      changedTree.delete();
      tree.delete();
    }
  }
});

test('keeps annotated function and object literals inside member expressions', () => {
  for (const expression of [
    'call() @Ann {}',
    'call() @Ann(")") { value() }',
    '1 use @Ann fun(x: Int) = x',
    '1 private @Ann fun(x: Int) = x',
    '1 private @Ann fun Int.(x: Int) = x',
    '1 private @Ann fun List<() -> Unit>.() {}',
    '1 private @Ann fun List<() -> (Pair<Int, Int>)>.() {}',
    '1 private @Ann fun @TypeAnn(")") List<() -> Unit>.() {}',
    '1 private @Ann object {}',
    '1 private @Ann object : Base() {}',
  ]) {
    const member = `fun f() = ${expression}`;
    const tree = parser.parse(`class C { ${member} }`)!;
    try {
      expect(tree.rootNode.hasError, member).toBe(false);
      expect(classMembers(tree.rootNode).map((node) => node.text)).toEqual([member]);
      expect(
        tree.rootNode.descendantsOfType(['annotated_lambda', 'annotated_expression']).map((node) => node.text)
      ).toEqual([expression.slice(expression.indexOf('@'))]);
    } finally {
      tree.delete();
    }
  }
});

test('retains immediate super labels before same-line members', () => {
  for (const target of ['super@C', 'super<A>@C']) {
    const first = `fun f() = ${target}.foo()`;
    const second = 'fun g() {}';
    const tree = parser.parse(`class C : A { ${first} ${second} }`)!;
    try {
      expect(tree.rootNode.hasError, first).toBe(false);
      expect(classMembers(tree.rootNode).map((node) => node.text)).toEqual([first, second]);
      expect(tree.rootNode.descendantsOfType('super_expression').map((node) => node.text)).toEqual([target]);
    } finally {
      tree.delete();
    }
  }
});

test('recovers from unfinished type arguments in annotated member headers', () => {
  for (const header of ['<', '<T', '<T ', '<List<', '<T /* unfinished', '<List<() -> Unit>']) {
    const source = `class C { fun f() {} @Ann fun ${header}`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError, source).toBe(true);
      expect(tree.rootNode.endIndex, source).toBe(source.length);
    } finally {
      tree.delete();
    }
  }
});

test('keeps functional interfaces separate without scanning their member bodies', () => {
  const first = 'fun first() {}';
  const declaration = 'fun interface I { val f: Int.() -> Unit get() = {}; fun run() }';
  const last = 'fun after() {}';
  for (const annotation of ['', '@Ann ']) {
    const member = annotation + declaration;
    const tree = parser.parse(`class C { ${first} ${member} ${last} }`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(
        classMembers(tree.rootNode)
          .map((node) => node.text)
          .filter((text) => [first, member, last].includes(text))
      ).toEqual([first, member, last]);
    } finally {
      tree.delete();
    }
  }
});

function classMembers(root: Node): Node[] {
  return root
    .descendantsOfType(['class_body', 'enum_class_body'])
    .flatMap((body) => body.namedChildren.filter((node) => !node.isExtra && node.type !== 'enum_entry'))
    .toSorted((left, right) => left.startIndex - right.startIndex);
}
