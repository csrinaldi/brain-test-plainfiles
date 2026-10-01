#!/usr/bin/env node
// tracker-board.mjs — Tablero vivo del tracker: mis tickets + sin asignar.
//
// Provider-agnóstico: pasa por el adapter de VCS (scripts/vcs/cli.mjs), así que
// funciona con GitHub, GitLab u otro host según `vcs.provider` en brain.config.json.
// Imprime markdown listo para el skill `retomar` (y cualquier otro consumidor).
// Degrada con aviso si no hay sesión de VCS autenticada o el remote no se detecta.
//
// Uso: node brain/scripts/tracker-board.mjs   |   npm run brain:tracker:board  (alias deprecado: tracker:board)

import { getVcs } from './vcs/cli.mjs';
import { originIdentity } from './vcs/lib/repo.mjs';
import { t } from './i18n/t.mjs';

const { host, project } = originIdentity();
if (!project) {
  console.log(await t('tracker.noRemote'));
  process.exit(0);
}

let vcs;
try {
  vcs = await getVcs();
} catch (e) {
  console.log(await t('tracker.vcsNotConfigured', { error: e.message }));
  process.exit(0);
}

let authed = false;
try { authed = await vcs.authCheck({ host }); } catch { authed = false; }
if (!authed) {
  console.log(await t('tracker.noSession', { host, project }));
  process.exit(0);
}

let currentUser = null;
try {
  currentUser = (await vcs.whoami()).username;
} catch {
  // stderr, para no contaminar el markdown que consume `retomar`.
  console.error(await t('tracker.noUser'));
}

const safeList = async (opts) => {
  try { return await vcs.issueList({ project, state: 'open', ...opts }); }
  catch { return []; }
};

const myIssues = currentUser ? await safeList({ assignee: 'me' }) : [];
const unassigned = await safeList({ assignee: 'none' });

const formatIssue = (i) => {
  const labels = i.labels?.length ? ` \`${i.labels.join('` `')}\`` : '';
  return `- #${i.number}${labels} ${i.title}`;
};

console.log(`## ${await t('tracker.yourTickets')}`);
if (myIssues.length === 0) {
  console.log(`- ${await t('common.none')}`);
} else {
  for (const i of myIssues) console.log(formatIssue(i));
}

console.log(`\n## ${await t('tracker.unassigned')}`);
if (unassigned.length === 0) {
  console.log(`- ${await t('common.none')}`);
} else {
  for (const i of unassigned) console.log(formatIssue(i));
}
