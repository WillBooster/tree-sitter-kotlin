import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

// Leaves time to kill the command and report its output before Vitest's own test timeout.
const KillMargin = 10_000;

// Tests that a command run from the repository root exits zero within the timeout, and passes its output to
// `check`. The command runs in its own process group, which the timeout kills as a whole: a scanner stuck in
// a loop keeps busy the CLI that a script such as script/fuzz-corpus starts, not the direct child.
export function testCommand(
  name: string,
  command: [string, ...string[]],
  timeout: number,
  options: { env?: Record<string, string>; check?: (output: string) => void } = {}
): void {
  test(
    name,
    async () => {
      const child = spawn(command[0], command.slice(1), {
        cwd: repositoryRoot,
        detached: true,
        // The CLI caches compiled parsers by language name in a directory shared by every checkout and reuses one that
        // is newer than the sources, so another checkout's parser could be tested instead of this one, also through a
        // TREE_SITTER_LIBDIR set in the environment.
        env: { ...process.env, TREE_SITTER_LIBDIR: `${repositoryRoot}/.tmp/tree-sitter-lib`, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => (output += data));
      child.stderr.on('data', (data) => (output += data));
      const killGroup = (): void => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // The group has already exited.
        }
      };
      // The group no longer receives the terminal's Ctrl-C, so the runner forwards its own end to it.
      const onSignal = (signal: NodeJS.Signals): void => {
        killGroup();
        process.kill(process.pid, signal);
      };
      process.on('exit', killGroup);
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      const timer = setTimeout(killGroup, timeout);
      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      clearTimeout(timer);
      process.off('exit', killGroup);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      expect(exitCode, output).toBe(0);
      options.check?.(output);
    },
    timeout + KillMargin
  );
}
