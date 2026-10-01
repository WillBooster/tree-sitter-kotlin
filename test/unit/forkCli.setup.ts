import { execFileSync } from 'node:child_process';

// The command tests run the CLI that script/fork-cli downloads or builds on first use (a build takes over 10 minutes on
// GitHub's Intel macOS runner), so it is provided once before them instead of by each concurrently within its timeout.
export default function setup(): void {
  execFileSync(`${import.meta.dirname}/../../script/fork-cli`, { stdio: ['ignore', 'ignore', 'inherit'] });
}
