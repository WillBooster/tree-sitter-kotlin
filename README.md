# @willbooster/tree-sitter-kotlin

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-kotlin.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-kotlin)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-kotlin.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-kotlin)
[![Test](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test-rust.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-21.3.0-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)
[![crates.io](https://img.shields.io/crates/v/willbooster-tree-sitter-kotlin.svg)](https://crates.io/crates/willbooster-tree-sitter-kotlin)

Kotlin grammar for [tree-sitter](https://github.com/tree-sitter/tree-sitter), forked from
[tree-sitter-grammars/tree-sitter-kotlin](https://github.com/tree-sitter-grammars/tree-sitter-kotlin). We are grateful
to its authors and contributors. This is not an official release of that project.

This fork fixes parsing bugs and raises conformance with the Kotlin grammar.

## Support Scope

This fork maintains only full parsing: valid input yields a correct tree, and invalid input yields `ERROR` or `MISSING`
nodes without crashing, hanging, or taking more than linear time. Incremental parsing is not supported, and no queries
(highlights, locals, injections, tags) are shipped. Node types, field names, and the trees that error recovery produces
may change; such changes are released as new major versions.

## Usage

The npm package ships `tree-sitter-kotlin.wasm` for
[@willbooster/web-tree-sitter](https://www.npmjs.com/package/@willbooster/web-tree-sitter), which runs in Node.js, Bun,
browsers, and Cloudflare Workers. The supported runtime is `@willbooster/web-tree-sitter` version 20.0.0 or later in the
20.x series; the upstream Tree-sitter runtime rejects this parser.

In Node.js and Bun:

```js
import { fileURLToPath } from 'node:url';

import { Language, Parser } from '@willbooster/web-tree-sitter';

await Parser.init();
const parser = new Parser();
const wasmPath = fileURLToPath(import.meta.resolve('@willbooster/tree-sitter-kotlin/tree-sitter-kotlin.wasm'));
parser.setLanguage(await Language.load(wasmPath));
const tree = parser.parse('fun main() = println("Hello")\n');
```

In browsers, load both `.wasm` files by URL. With Vite:

```js
import kotlinUrl from '@willbooster/tree-sitter-kotlin/tree-sitter-kotlin.wasm?url';
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';

await Parser.init({ locateFile: () => runtimeUrl });
const parser = new Parser();
parser.setLanguage(await Language.load(kotlinUrl));
```

In Cloudflare Workers, which do not allow compiling Wasm at run time, import both `.wasm` files as modules (with or
without Node.js compatibility):

```js
import kotlin from '@willbooster/tree-sitter-kotlin/tree-sitter-kotlin.wasm';
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtime from '@willbooster/web-tree-sitter/web-tree-sitter.wasm';

await Parser.init({ wasmModule: runtime });
const parser = new Parser();
parser.setLanguage(await Language.load(kotlin));
```

The package also ships the node types in `src/node-types.json`.

In Rust, depend on the [crate](https://crates.io/crates/willbooster-tree-sitter-kotlin) and on
[willbooster-tree-sitter](https://crates.io/crates/willbooster-tree-sitter), the runtime with the matching ABI that this
package is tested and fuzzed with. Use version 20.0.0 or later in the 20.x series:

```sh
cargo add willbooster-tree-sitter@20.0.0 --rename tree-sitter
cargo add willbooster-tree-sitter-kotlin --rename tree-sitter-kotlin
```

```rust
let mut parser = tree_sitter::Parser::new();
parser.set_language(&tree_sitter_kotlin::LANGUAGE.into())?;
```

## Development

```sh
mise install
bun install --frozen-lockfile
bun run test/ci-setup
bun run build/ci
bun run verify
bun run test
cargo test
```

- `script/tree-sitter` runs the `WillBooster/tree-sitter` CLI locked in `Cargo.lock` (`script/runtime-version`). Keep `@willbooster/web-tree-sitter` in `package.json` and `willbooster-tree-sitter` in `Cargo.lock` at the same version.
- Run `bun run build-wasm` and commit `src/` after changing `grammar.js`, `tree-sitter.json`, `test/corpus/`, or Git-tracked `examples/`. Stage added or removed files under `examples/` with `git add -A examples` before regenerating.
- Run `script/parse-examples` to update `script/known-failures.txt` after a grammar change or a pin update in `script/parse-examples` alters which pinned examples fail to parse.

### References

- [Kotlin Grammar](https://kotlinlang.org/docs/reference/grammar.html)
