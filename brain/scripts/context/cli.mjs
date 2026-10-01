#!/usr/bin/env node
// cli.mjs — CLI entrypoint for Intelligent Context Synthesizer (REQ-CTX-4).

import { execSync } from 'node:child_process';
import { synthesizeContext } from './synthesizer.mjs';

async function main() {
  let touchedFiles = [];
  try {
    const diff = execSync('git diff --name-only origin/feature/v2.0.0...HEAD', { encoding: 'utf8' });
    touchedFiles = diff.split('\n').filter(Boolean);
  } catch {
    // fallback if git diff fails in shallow or un-fetched repo
  }

  const result = await synthesizeContext({ touchedFiles });
  console.log(result.markdown);
}

main().catch(err => {
  console.error('brain:context:compile error:', err);
  process.exit(1);
});
