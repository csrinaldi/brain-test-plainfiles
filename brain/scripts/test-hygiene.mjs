// Pretest sweep (#842): remove fixture roots left by DEAD runs. In-process
// exit hooks cannot survive SIGKILL; this is the half of the mechanism that
// runs while nobody is dying. See lib/test-tmp.mjs for the whole contract.
import { sweepStaleRuns } from './lib/test-tmp.mjs';

const { swept } = sweepStaleRuns();
if (swept.length > 0) {
  console.log(`test-hygiene: swept ${swept.length} stale fixture root(s) left by dead test runs`);
}
