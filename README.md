# @willbooster/tree-sitter-kotlin

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-kotlin.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-kotlin)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-kotlin.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-kotlin)
[![Test](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test-rust.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.23.2-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

Kotlin grammar for [tree-sitter](https://github.com/tree-sitter/tree-sitter), forked from
[tree-sitter-grammars/tree-sitter-kotlin](https://github.com/tree-sitter-grammars/tree-sitter-kotlin). We are grateful
to its authors and contributors. This is not an official release of that project.

This fork fixes parsing bugs and raises conformance with the Kotlin grammar.

## Usage

The npm package ships `tree-sitter-kotlin.wasm` for [web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter):

```js
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

await Parser.init();
const parser = new Parser();
const wasmPath = fileURLToPath(import.meta.resolve('@willbooster/tree-sitter-kotlin/tree-sitter-kotlin.wasm'));
parser.setLanguage(await Language.load(wasmPath));
const tree = parser.parse('fun main() = println("Hello")\n');
```

The package also ships the node types in `src/node-types.json`.

In Rust, depend on the Git repository; the crate is not published to crates.io:

```toml
[dependencies]
tree-sitter = "0.27"
tree-sitter-kotlin = { package = "willbooster-tree-sitter-kotlin", git = "https://github.com/WillBooster/tree-sitter-kotlin", tag = "v1.1.0" }
```

```rust
let mut parser = tree_sitter::Parser::new();
parser.set_language(&tree_sitter_kotlin::LANGUAGE.into())?;
```

## Development

```sh
mise install
bun install --frozen-lockfile
bun run build/ci
bun run test
script/parse-examples
cargo test
```

`bun run test` runs:

- the corpus in `test/corpus`, with the native build and with the Wasm build (the first run downloads the WASI SDK);
- an incremental-parsing check (`test/unit/incremental.test.ts`): `tree-sitter fuzz` edits each corpus case at random,
  reparses it, undoes the edits, and reparses again. `TREE_SITTER_SEED`, `TREE_SITTER_ITERATIONS`, and
  `TREE_SITTER_EDITS` run other or more edits;
- a check that real-world Kotlin files cloned into `examples/` fail to parse exactly as listed in
  `script/known-failures.txt`. The first run clones them. The example repositories are pinned to commits in
  `script/parse-examples`. After a grammar change or a moved pin alters that list, `script/parse-examples` rewrites
  it; review its diff before committing;
- a performance check (`test/unit/performance.test.ts`) that recovering from an error on each of 10,000 lines takes
  linear time, since consumers parse files while they are being edited. It loads the Wasm build through
  web-tree-sitter, which `bun run build/ci` rebuilds after regenerating the parser.

CI also runs these tests on Linux arm64 and macOS, where the Rust binding compiles the parser natively, and fuzzes the parser with libFuzzer and sanitizers
(`.github/workflows/robustness.yml`).

### References

- [Kotlin Grammar](https://kotlinlang.org/docs/reference/grammar.html)
