#!/usr/bin/env node
// snapshot-cli.mjs — `brain:snapshot`: the read model as a verb (#879, D7).
//
// Prints what `snapshot.mjs` returns and adds nothing — `--json` is
// `JSON.stringify(snapshot, null, 2)`, text mode is `renderSnapshotText` over
// the same object. The parity test spawns this file and compares its output
// with an in-process `buildSnapshot` on the same tree and the same `--now`.
//
// A REPORT, NOT A GATE. Exit 0 in every computed case, an unreachable forge
// included: each section says what it could not read. Exit 2 only for an
// argument this verb does not understand.
//
// Usage: npm run brain:snapshot -- [--json] [--now <iso>] [--root <dir>]

import { buildSnapshot, renderSnapshotText } from './snapshot.mjs';

/** @returns {{ok:true,json:boolean,now:string|undefined,root:string|undefined}|{ok:false,error:string}} */
export function parseArgs(argv = []) {
  const out = { ok: true, json: false, now: undefined, root: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--now') {
      const v = argv[++i];
      if (!v || Number.isNaN(Date.parse(v))) return { ok: false, error: '--now needs an ISO-8601 timestamp' };
      out.now = v;
    } else if (a === '--root') {
      const v = argv[++i];
      if (!v) return { ok: false, error: '--root needs a directory' };
      out.root = v;
    } else return { ok: false, error: `unknown argument: ${a}` };
  }
  return out;
}

export async function main(argv = [], deps = {}) {
  const say = deps.say ?? console.log;
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`✗ ${parsed.error}\n  Usage: npm run brain:snapshot -- [--json] [--now <iso>] [--root <dir>]`);
    return 2;
  }
  const snapshot = await buildSnapshot({
    root: parsed.root ?? process.cwd(),
    now: parsed.now,
    vcs: deps.vcs ?? null,
    project: deps.project ?? null,
  });
  say(parsed.json ? JSON.stringify(snapshot, null, 2) : renderSnapshotText(snapshot));
  return 0;
}

// Guarded like `status/cli.mjs`: importing this module never reaches a forge.
if (import.meta.url === `file://${process.argv[1]}`) {
  let vcs = null;
  let project = null;
  // `--root` points the snapshot at another tree; the forge identity is still
  // this checkout's, which is the only remote this process can read. A test
  // fixture has no remote and gets the "no project" reason, in band.
  if (!process.argv.includes('--root')) {
    try {
      const { getVcs } = await import('../vcs/cli.mjs');
      const { originIdentity } = await import('../vcs/lib/repo.mjs');
      vcs = await getVcs();
      project = originIdentity()?.project ?? null;
    } catch { /* degrades to uncomputable forge sections, never a crash */ }
  }
  process.exit(await main(process.argv.slice(2), { vcs, project }));
}
