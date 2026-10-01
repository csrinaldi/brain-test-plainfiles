#!/usr/bin/env python3
"""pty-drive.py — drive an interactive shell script under a real pseudo-tty.

issue #1112, cold-review round 3, should-fix 2: proving env:init's
fail-closed PAT write gate end to end needs a REAL interactive run —
bootstrap.sh's PAT section only prompts when `[ -t 0 ]` is true, and piped
(non-tty) stdin takes its "no TTY" branch instead, never reaching the write
gate at all. Node has no built-in pty; python3 is already a required base
dependency of this project (bootstrap.sh's own §1), so it is the zero-new-
dependency way to allocate one.

Usage:
    python3 pty-drive.py <cmd> [args...]

Configuration via environment variables (kept out of argv so a fake secret
in a scripted answer never appears in a process listing):
    PTY_STEPS      Required. A JSON array of [pattern, b64_reply] pairs.
                   `pattern` is a regex (bytes, DOTALL not needed — matched
                   against the accumulated output so far); `b64_reply` is the
                   base64-encoded bytes to write once `pattern` first matches,
                   including any trailing newline the prompt needs.
    PTY_TIMEOUT    Optional. Seconds before giving up and killing the child
                   (default 90).

Behavior:
    Reads the child's combined stdout+stderr (both attached to the pty's
    slave side, like a real terminal), answering each step in order as its
    pattern first appears. Writes the full transcript to this process's own
    stdout, then exits with the child's real exit code — or 124 (the
    conventional `timeout(1)` code) if the deadline passes first, with a note
    on stderr naming how many of the steps were actually reached.
"""

import base64
import json
import os
import pty
import re
import select
import subprocess
import sys
import time


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: pty-drive.py <cmd> [args...]\n")
        return 2

    raw_steps = os.environ.get("PTY_STEPS")
    if not raw_steps:
        sys.stderr.write("PTY_STEPS env var is required (JSON array of [pattern, b64_reply])\n")
        return 2
    steps = [(re.compile(pattern.encode()), base64.b64decode(b64_reply)) for pattern, b64_reply in json.loads(raw_steps)]

    timeout = float(os.environ.get("PTY_TIMEOUT", "90"))

    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(sys.argv[1:], stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, close_fds=True)
    os.close(slave_fd)

    buf = b""
    step_i = 0
    deadline = time.time() + timeout
    timed_out = False

    while True:
        if time.time() > deadline:
            timed_out = True
            try:
                proc.terminate()
            except OSError:
                pass
            break
        ready, _, _ = select.select([master_fd], [], [], 1.0)
        if master_fd in ready:
            try:
                chunk = os.read(master_fd, 65536)
            except OSError:
                chunk = b""
            if chunk:
                buf += chunk
                while step_i < len(steps) and steps[step_i][0].search(buf):
                    os.write(master_fd, steps[step_i][1])
                    step_i += 1
            elif proc.poll() is not None:
                break
        if proc.poll() is not None:
            # Drain whatever the child wrote between the last read and exit.
            try:
                while True:
                    ready2, _, _ = select.select([master_fd], [], [], 0.3)
                    if not ready2:
                        break
                    chunk = os.read(master_fd, 65536)
                    if not chunk:
                        break
                    buf += chunk
            except OSError:
                pass
            break

    try:
        os.close(master_fd)
    except OSError:
        pass

    if timed_out:
        try:
            rc = proc.wait(timeout=5)
        except Exception:
            proc.kill()
            rc = None
        sys.stdout.buffer.write(buf)
        sys.stdout.buffer.flush()
        sys.stderr.write(f"pty-drive.py: TIMEOUT after {timeout}s — {step_i}/{len(steps)} step(s) sent\n")
        return 124

    rc = proc.wait()
    sys.stdout.buffer.write(buf)
    sys.stdout.buffer.flush()
    if step_i < len(steps):
        sys.stderr.write(f"pty-drive.py: child exited before all steps were sent — {step_i}/{len(steps)}\n")
    return rc


if __name__ == "__main__":
    sys.exit(main())
