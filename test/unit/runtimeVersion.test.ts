import fs from 'node:fs';

import { expect, test } from 'vitest';

import packageJson from '../../package.json';

// The Wasm tests run on @willbooster/web-tree-sitter, and the Rust tests and the fuzz job on the willbooster-tree-sitter
// crate that Cargo.lock locks. Both are the same runtime, released together, so they must be tested at one version.
test('locks the same runtime version in package.json and Cargo.lock', () => {
  const cargoLock = fs.readFileSync(`${import.meta.dirname}/../../Cargo.lock`, 'utf8');
  const crateVersion = /^name = "willbooster-tree-sitter"\nversion = "([^"]+)"$/m.exec(cargoLock)?.[1];
  expect(crateVersion).toBe(packageJson.devDependencies['@willbooster/web-tree-sitter']);
});
