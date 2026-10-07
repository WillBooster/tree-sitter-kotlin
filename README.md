# @willbooster/tree-sitter-kotlin

[![npm version](https://img.shields.io/npm/v/@willbooster/tree-sitter-kotlin.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-kotlin)
[![license](https://img.shields.io/npm/l/@willbooster/tree-sitter-kotlin.svg)](https://www.npmjs.com/package/@willbooster/tree-sitter-kotlin)
[![Test](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/tree-sitter-kotlin/actions/workflows/test-rust.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.28.7-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)
[![crates.io](https://img.shields.io/crates/v/willbooster-tree-sitter-kotlin.svg)](https://crates.io/crates/willbooster-tree-sitter-kotlin)

Kotlin grammar for [tree-sitter](https://github.com/tree-sitter/tree-sitter), forked from
[tree-sitter-grammars/tree-sitter-kotlin](https://github.com/tree-sitter-grammars/tree-sitter-kotlin). We are grateful
to its authors and contributors. This is not an official release of that project.

This fork fixes parsing bugs and raises conformance with the Kotlin grammar.

## Usage

The npm package ships `tree-sitter-kotlin.wasm` for
[@willbooster/web-tree-sitter](https://www.npmjs.com/package/@willbooster/web-tree-sitter), which runs in Node.js, Bun,
browsers, and Cloudflare Workers. The compact ABI 16 parser requires runtime 1.3.0 or later.

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
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import kotlinUrl from '@willbooster/tree-sitter-kotlin/tree-sitter-kotlin.wasm?url';

await Parser.init({ locateFile: () => runtimeUrl });
const parser = new Parser();
parser.setLanguage(await Language.load(kotlinUrl));
```

In Cloudflare Workers, which do not allow compiling Wasm at run time, import both `.wasm` files as modules (with or
without Node.js compatibility):

```js
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtime from '@willbooster/web-tree-sitter/web-tree-sitter.wasm';
import kotlin from '@willbooster/tree-sitter-kotlin/tree-sitter-kotlin.wasm';

await Parser.init({ wasmModule: runtime });
const parser = new Parser();
parser.setLanguage(await Language.load(kotlin));
```

The package also ships the node types in `src/node-types.json`.

In Rust, depend on the [crate](https://crates.io/crates/willbooster-tree-sitter-kotlin) and on
[willbooster-tree-sitter](https://crates.io/crates/willbooster-tree-sitter), the runtime this package is tested and
fuzzed with. The compact ABI 16 parser requires runtime 1.3.0 or later:

```toml
[dependencies]
tree-sitter = { package = "willbooster-tree-sitter", version = "1.3.0" }
tree-sitter-kotlin = { package = "willbooster-tree-sitter-kotlin", version = "4" }
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
bun run test
script/parse-examples
cargo test
```

Every `tree-sitter` command, from `generate` to the tests, runs the CLI of the WillBooster/tree-sitter runtime version
locked in `Cargo.lock` (`script/tree-sitter`), whose generator and runtime have fixes that the upstream CLI lacks.
`script/fork-cli` downloads that CLI into `.tmp/` from its GitHub Release on first use, or builds it with `cargo` when
the download fails or the release has no binary that runs here.

`bun run generate` records a fresh ABI 16 generation profile from the applicable `test/corpus` cases and Git-tracked
files in `examples/`, then generates compact parser tables. After changing a grammar, corpus case, or tracked example,
regenerate and commit `src/`. Stage added or removed examples with `git add -A examples` before generation so the profile uses the intended file list.
Profiles in `.tmp/generation-profiles/` are temporary and must not be committed. `bun run build-wasm`, `bun run build/ci`,
and the release build regenerate the parsers before compiling them.

`bun run test` runs:

- the corpus in `test/corpus`, with the native build and with the Wasm build (the first run downloads the WASI SDK);
- an incremental-parsing check (`test/unit/incremental.test.ts`): `script/fuzz-corpus` runs `tree-sitter fuzz`, which
  edits each corpus case at random, reparses it, undoes the edits, and reparses again. `TREE_SITTER_SEED`,
  `TREE_SITTER_ITERATIONS`, and `TREE_SITTER_EDITS` run other or more edits;
- a check that real-world Kotlin files cloned into `examples/` fail to parse exactly as listed in
  `script/known-failures.txt`. The first run clones them. The example repositories are pinned to commits in
  `script/parse-examples`. After a grammar change or a moved pin alters that list, `script/parse-examples` rewrites
  it; review its diff before committing;
- a performance check (`test/unit/performance.test.ts`) that recovering from an error on each line takes linear time
  (ten times the lines take about ten times the CPU time, under a ceiling), since consumers parse files while they are
  being edited. It loads the Wasm build through @willbooster/web-tree-sitter, which `bun run build/ci` rebuilds after
  regenerating the parser;
- a check that `package.json` and `Cargo.lock` test the same runtime version (`test/unit/runtimeVersion.test.ts`);
- checks that the Wasm build parses Kotlin through @willbooster/web-tree-sitter in Chromium
  (`test/unit/browser.test.ts`) and in Cloudflare Workers with and without Node.js compatibility
  (`test/unit/workers.test.ts`).

The tests and `script/parse-examples` compile the parser into `.tmp/tree-sitter-lib` rather than the CLI's cache shared
by every checkout, and `mise.toml` sets `TREE_SITTER_LIBDIR` to it for any other command run in the checkout;
`script/fuzz-corpus` builds a parser of its own in `.tmp/fuzz` for each run and deletes it afterwards.

CI also runs these tests on Linux arm64 and macOS, where the Rust binding compiles the parser natively, and fuzzes the
parser with libFuzzer and sanitizers (`.github/workflows/robustness.yml`).

### References

- [Kotlin Grammar](https://kotlinlang.org/docs/reference/grammar.html)
