// brain/scripts/axes/platform/lib/settings-hooks.mjs — the ONE native-settings
// hooks compiler shared by the platform backends (issue #315).
//
// What was measured before this existed (numbers in the PR): claude.mjs's
// `compileClaudeSettingsJson` and antigravity.mjs's `compileGeminiSettingsJson`
// were 28 lines each and 27 of those lines were byte-identical — the single
// differing line was the function's own name. Their OUTPUT was byte-identical:
// md5 7d4dcb282df653b2121e98228e6ac569 — 776 characters, 777 bytes
// in UTF-8 (the payload carries a "§"), both.
//
// The emit paths were NOT part of the duplication and are NOT a parameter here.
// `.claude/settings.json` and `.gemini/settings.json` live in each backend as
// its own exported constant and stay there — that is the one thing that really
// differs per platform, and it never sat inside the compiler.
//
// So this function takes no arguments. Injecting an `emitPath` it does not use
// would unify a difference that does not exist, which is worse than leaving two
// copies alone: it invites a future reader to believe the payload varies by
// platform. It does not. A copy of two drifts; a function cannot.
//
// The `--no-verify` blocker below is the security-relevant reason this matters.
// It was copy-pasted, so the two copies could silently diverge and one harness
// could end up enforcing ADR-0014 §9 while the other quietly stopped.

/**
 * The PreToolUse guard that refuses `--no-verify` / `git commit -n`.
 * Single copy on purpose — `settings-hooks.test.mjs` fails if a second one
 * appears in any other backend, and RUNS this one to prove it still blocks.
 */
export const NO_VERIFY_GUARD_COMMAND =
  "node -e \"const cmd = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).tool_input?.command ?? ''; if (/--no-verify/.test(cmd) || /\\bgit commit\\b[^|&\\n]*\\s+-n\\b/.test(cmd)) { process.stderr.write('\\n[brain:hook] BLOCKED: --no-verify / git commit -n bypasses governance hooks.\\nSee ADR-0014 §9. Fix the hook that is causing the false-positive instead.\\n'); process.exit(2); }\"";

/** The SessionStart hook every platform runs to load session context. */
export const SESSION_START_COMMAND = 'npm run brain:session:start';

/**
 * The SessionEnd hook every platform runs on teardown (#906, ADR-0034 L5,
 * ruling D1/D2). Emitted UNCONDITIONALLY, on every consumer, regardless of
 * `memory.lane.enabled` — the compiler stays argument-free and the drift
 * guard byte-stable in both flag states. Safety lives entirely in the
 * launcher this command invokes (`memory/session-end-ship.mjs`), which reads
 * the flag FIRST and is silent when it is false or absent.
 */
export const SESSION_END_COMMAND = 'npm run brain:memory:session-end';

/**
 * Compiles the native settings-hooks JSON shared by every platform backend.
 * Pure, fs-free, deterministic — the same bytes on every call.
 *
 * @returns {string} The formatted JSON content, newline-terminated.
 */
export function compileSettingsHooksJson() {
  const obj = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: NO_VERIFY_GUARD_COMMAND,
            },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: SESSION_START_COMMAND,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: SESSION_END_COMMAND,
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(obj, null, 2) + '\n';
}
