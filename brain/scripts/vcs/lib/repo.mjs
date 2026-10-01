// repo.mjs — Derive the repo identity (host + slug) from the git origin remote.
//
// Provider-agnostic: works for GitHub, GitLab, or any host, over HTTPS or SSH.
// Callers pass the returned `project` (owner/repo or group/path slug) to the VCS
// adapter verbs and `host` to auth verbs. Returns nulls if origin is absent.

import { execSync } from 'node:child_process';

/**
 * Parses a git remote URL into { host, project }. Pure — unit tested.
 * Handles https://host(:port)/group/.../repo(.git) and git@host:group/.../repo(.git),
 * optional embedded credentials, subgroups, and an optional HTTPS port (dropped
 * from host so the project slug stays clean).
 * @param {string} url
 * @returns {{ host: string|null, project: string|null }}
 */
export function parseRemote(url) {
  const m = String(url).trim().match(
    /(?:https?:\/\/(?:[^@/]+@)?|git@)([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?$/,
  );
  return m ? { host: m[1], project: m[2] } : { host: null, project: null };
}

/**
 * @returns {{ host: string|null, project: string|null }}
 */
export function originIdentity() {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' });
    return parseRemote(url);
  } catch {
    return { host: null, project: null };
  }
}
