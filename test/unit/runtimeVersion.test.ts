import { execFileSync } from 'node:child_process';

import { expect, test } from 'vitest';

import packageJson from '../../package.json';

// The Wasm tests run on @willbooster/web-tree-sitter, and the Rust tests, the fuzz job, and the incremental check on
// the willbooster-tree-sitter crate that Cargo.lock locks (read by script/runtime-version). Both are the same runtime,
// released together, so they must be tested at one version.
test('locks the same runtime version in package.json and Cargo.lock', () => {
  const crateVersion = execFileSync(`${import.meta.dirname}/../../script/runtime-version`, { encoding: 'utf8' }).trim();
  expect(crateVersion).toBe(packageJson.devDependencies['@willbooster/web-tree-sitter']);
});
