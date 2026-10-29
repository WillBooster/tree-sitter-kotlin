import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, expect, test } from 'vitest';

let parser: Parser;
let query: Query;

beforeAll(async () => {
  await Parser.init();
  const language = await Language.load('tree-sitter-kotlin.wasm');
  parser = new Parser().setLanguage(language);
  query = new Query(language, '[(import) (qualified_identifier) (".") (block_comment) (line_comment)] @capture');
});

afterAll(() => {
  query.delete();
  parser.delete();
});

test.each([
  ['\n', []],
  ['\r\n', []],
  [' /* trailing */\n', ['/* trailing */']],
  ['\n/* next */ ', ['/* next */']],
  ['\n// next\n', ['// next']],
  ['\n/* first */ /* second */ ', ['/* first */', '/* second */']],
] as const)('recovers the following imports across %j after a trailing dot', (boundary, comments) => {
  const source = `import foo.bar.${boundary}import baz.qux as Qux\nimport other.*\nclass After {}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(true);
    expect(
      tree.rootNode
        .descendantsOfType('import')
        .filter((node) => node.isNamed)
        .map((node) => node.text),
      source
    ).toEqual(['import foo.bar', 'import baz.qux as Qux', 'import other.*']);
    expect(tree.rootNode.descendantsOfType('class_declaration').map((node) => node.text)).toEqual(['class After {}']);
    expect(tree.rootNode.descendantsOfType('navigation_expression')).toHaveLength(0);
    expect(tree.rootNode.descendantsOfType('ERROR').map((node) => node.text)).toEqual(['.']);
    expect(
      query
        .captures(tree.rootNode)
        .filter(({ node }) => node.type.endsWith('_comment'))
        .map(({ node }) => node.text)
    ).toEqual(comments);
    for (const { node } of query.captures(tree.rootNode)) {
      expect(source.slice(node.startIndex, node.endIndex)).toBe(node.text);
      if (node.type === '.') expect(node.text).toBe('.');
    }
  } finally {
    tree.delete();
  }
});

test.each(['// section', '/* section */', '/** Documentation */', '/* first\nsecond */'])(
  'keeps %j after an import outside its range',
  (comment) => {
    const source = `import a.b\n${comment}\nfun after() = 1`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([
        'import',
        comment.startsWith('//') ? 'line_comment' : 'block_comment',
        'function_declaration',
      ]);
      const declaration = tree.rootNode.firstNamedChild!;
      expect([declaration.text, declaration.startIndex, declaration.endIndex]).toEqual(['import a.b', 0, 10]);
      const commentNode = tree.rootNode.namedChildren[1]!;
      expect([commentNode.text, commentNode.startIndex, commentNode.endIndex]).toEqual([
        comment,
        11,
        11 + comment.length,
      ]);
    } finally {
      tree.delete();
    }
  }
);

test('keeps an import-line comment outside the import', () => {
  const tree = parser.parse('import a.b // trailing\nclass After {}')!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.namedChildren.map((node) => [node.type, node.text])).toEqual([
      ['import', 'import a.b'],
      ['line_comment', '// trailing'],
      ['class_declaration', 'class After {}'],
    ]);
  } finally {
    tree.delete();
  }
});

test.each(['', ';', '}'])('retains an import before a trailing dot followed by %j', (ending) => {
  const source = `import a.b.${ending}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(true);
    expect(tree.rootNode.descendantsOfType('qualified_identifier').map((node) => node.text)).toEqual(['a.b']);
    expect(
      tree.rootNode
        .descendantsOfType('ERROR')
        .map((node) => node.text)
        .join('')
    ).toContain('.');
  } finally {
    tree.delete();
  }
});

test.each([';', '}', ' /* comment */ ;', ' /* comment */ }'])(
  'keeps later imports and declarations after a trailing dot and %j',
  (ending) => {
    const source = `import a.b.${ending}\nimport c.d\nclass After {}`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
      expect(tree.rootNode.descendantsOfType('qualified_identifier').map((node) => node.text)).toEqual(['a.b', 'c.d']);
      expect(tree.rootNode.descendantsOfType('import').filter((node) => node.isNamed)).toHaveLength(2);
      expect(tree.rootNode.descendantsOfType('class_declaration').map((node) => node.text)).toEqual(['class After {}']);
    } finally {
      tree.delete();
    }
  }
);

test.each([
  ['import kotlin.math.abs\nimport kotlin.math.max', []],
  ['import kotlin.math.abs import kotlin.math.max', []],
  ['import kotlin /* path */ . math.abs', ['/* path */']],
  ['import kotlin\n. math\n. abs', []],
  ['import kotlin.math.\n*', []],
  ['import kotlin.math. // wildcard\n*', ['// wildcard']],
  ['import kotlin.math. /* block\ncomment */ abs', ['/* block\ncomment */']],
  ['import kotlin.math. /* block\ncomment */ *', ['/* block\ncomment */']],
  ['import kotlin.math.abs as import', []],
  ['import sample.import.Target', []],
  ['import sample.imported.Target', []],
  ['import sample.importé.Target', []],
  ['import sample. /* block\ncomment */ import.Target', ['/* block\ncomment */']],
] as const)('preserves valid import paths, contextual names and token ranges in %s', (imports, comments) => {
  const source = `${imports}\nclass After {}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(false);
    expect(
      query
        .captures(tree.rootNode)
        .filter(({ node }) => node.type.endsWith('_comment'))
        .map(({ node }) => node.text)
    ).toEqual(comments);
    const declarations = tree.rootNode.descendantsOfType('import').filter((node) => node.isNamed);
    expect(declarations.map((node) => node.text).join(' ')).toBe(imports.replace('\nimport ', ' import '));
    for (const declaration of declarations) {
      expect(declaration.namedChildren.find((child) => !child.isExtra)?.type).toBe('qualified_identifier');
    }
    for (const { node } of query.captures(tree.rootNode)) {
      expect(source.slice(node.startIndex, node.endIndex)).toBe(node.text);
      if (node.type === '.') {
        expect(node.text).toBe('.');
        expect(node.endIndex - node.startIndex).toBe(1);
      }
    }
    expect(tree.rootNode.descendantsOfType('class_declaration')[0]?.childForFieldName('name')?.text).toBe('After');
  } finally {
    tree.delete();
  }
});

test.each(['\n', '\r\n', '\n/* next */ ', '\n// next\n'])(
  'recovers the following import after a trailing dot before %j below a multibyte comment',
  (boundary) => {
    const source = `// 引用\nimport kotlin.math.abs${boundary}import kotlin.math.max\nclass After {}`;
    const index = source.indexOf('abs') + 3;
    const changed = source.slice(0, index) + '.' + source.slice(index);
    const original = parser.parse(source)!;
    const dotted = parser.parse(changed)!;
    try {
      expect(original.rootNode.hasError).toBe(false);
      expect(dotted.rootNode.hasError).toBe(true);
      expect(
        dotted.rootNode
          .descendantsOfType('import')
          .filter((node) => node.isNamed)
          .map((node) => node.text)
      ).toEqual(['import kotlin.math.abs', 'import kotlin.math.max']);
    } finally {
      original.delete();
      dotted.delete();
    }
  }
);
