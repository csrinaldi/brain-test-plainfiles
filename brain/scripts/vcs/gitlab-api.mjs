// gitlab-api.mjs — Shared GitLab REST v4 fetch transport (issue #231 CP-A2b
// live-validation finding #12: "never a second parser" doctrine).
//
// PURE by construction: takes { apiBase, token, proxyUrl, path, fetchImpl }
// as plain arguments and reads NO environment itself. This is deliberate —
// callers that ARE sanctioned to read pipeline env (ci-context.mjs, the sole
// reader per the drift-guard) resolve apiBase/token/proxyUrl and thread them
// in here; a GATE_FILE consumer (axes/vcs/adapters/gitlab.mjs) receives them as
// parameters from ITS caller and never reads the GitLab API base URL
// pipeline var directly either (ci-context-drift-guard.test.mjs forbids it
// explicitly).
//
// ONE fetcher, N consumers: ci-context.mjs's defaultFetchMr (the MR body/
// labels/author call, REQ-CIC-5) and axes/vcs/adapters/gitlab.mjs's issueView (the
// CI-consumed verb migrated off the glab CLI, finding #12) both call this
// same helper — never a second hand-rolled GitLab API fetch elsewhere.

/**
 * Issues one authenticated GET against the GitLab REST v4 API and returns
 * the parsed JSON body. Never falls back to a CLI/spawn transport — this
 * module has no such fallback to fall back to.
 *
 * `method` defaults to `'GET'` (every read verb above stays unaffected); an
 * explicit `method` + `body` (issue #239 A3 Phase 2 — `gitlab.mrCreate`'s
 * write call over this SAME shared transport, never a second hand-rolled
 * fetch) serializes `body` to JSON and sets `Content-Type: application/json`.
 *
 * @param {{
 *   apiBase: string,
 *   path: string,
 *   token?: string|null,
 *   proxyUrl?: string|null,
 *   fetchImpl?: Function,
 *   method?: string,
 *   body?: any,
 * }} params
 * @returns {Promise<any>}
 */
export async function gitlabApiFetch({ apiBase, path, token, proxyUrl, fetchImpl, method = 'GET', body } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  const url = `${apiBase}/${path}`;
  const headers = token ? { 'PRIVATE-TOKEN': token } : {};
  const options = { method, headers };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  // Proxy is read from whatever the caller resolved — never hard-coded here.
  // The ProxyAgent dispatcher is best-effort: this repo ships zero npm
  // dependencies, so when 'undici' is not installed the request proceeds
  // unproxied rather than throwing (never a fabricated failure for the
  // common no-proxy case).
  if (proxyUrl) {
    try {
      const { ProxyAgent } = await import('undici');
      options.dispatcher = new ProxyAgent(proxyUrl);
    } catch {
      // undici unavailable — proceed unproxied.
    }
  }

  const res = await fetchFn(url, options);
  if (!res.ok) throw new Error(`GitLab API failed: ${res.status} (${path})`);
  return res.json();
}
