# @willbooster/tree-sitter-kotlin

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-kotlin.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-kotlin)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-kotlin.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-kotlin)
[![Test](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.21.1-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

Kotlin grammar for [tree-sitter](https://github.com/tree-sitter/tree-sitter), forked from
[tree-sitter-grammars/tree-sitter-kotlin](https://github.com/tree-sitter-grammars/tree-sitter-kotlin). We are grateful
to its authors and contributors. This is not an official release of that project.

This fork fixes parsing bugs and raises conformance with the Kotlin grammar.

## Usage

```js
const Parser = require('tree-sitter');
const Kotlin = require('@willbooster/tree-sitter-kotlin');

const parser = new Parser();
parser.setLanguage(Kotlin);
const tree = parser.parse('fun main() = println("Hello")\n');
```

## Development

```sh
mise install
bun install --frozen-lockfile
bun run build/ci
bun run test
script/parse-examples
```

`bun run test` runs:

- the corpus in `test/corpus`, with the native build and with the Wasm build (the first run downloads the WASI SDK);
- an incremental-parsing check (`test/unit/incremental.test.ts`): `tree-sitter fuzz` edits each corpus case at random,
  reparses it, undoes the edits, and reparses again. `TREE_SITTER_SEED`, `TREE_SITTER_ITERATIONS`, and
  `TREE_SITTER_EDITS` run other or more edits;
- the Node.js binding test;
- a check that real-world Kotlin files cloned into `examples/` fail to parse exactly as listed in
  `script/known-failures.txt`. The first run clones them. The example repositories are pinned to commits in
  `script/parse-examples`. After a grammar change or a moved pin alters that list, `script/parse-examples` rewrites
  it; review its diff before committing.

CI also runs these tests on every platform that gets a prebuild, and fuzzes the parser with libFuzzer and sanitizers
(`.github/workflows/robustness.yml`).

### References

- [Kotlin Grammar](https://kotlinlang.org/docs/reference/grammar.html)
