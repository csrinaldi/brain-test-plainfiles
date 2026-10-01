// brain/scripts/i18n/en.mjs — Canonical English catalog.
//
// Every key used by any brain script must live here. Other locale catalogs
// (e.g. es.mjs) are partial; any key they omit falls back to this file
// per-key. Templates use named {placeholder} slots for dynamic values.
//
// Keys are dotted, grouped by script: <script>.<section>.<name>
// e.g. 'day.auth.ok', 'tracker.yourTickets', 'common.none'
//
// Grows as scripts are migrated in PR2 and PR3.
export default {
  // ── Seed keys (PR1) ──────────────────────────────────────────────────────────
  'day.auth.ok':        'Authenticated as @{user} ({provider}).',
  'tracker.yourTickets': 'Your tickets',
  'common.none':        '(none)',

  // ── Shared ───────────────────────────────────────────────────────────────────
  'common.signal': 'signal',

  // ── day-start.mjs (PR2) ──────────────────────────────────────────────────────
  // run() utility
  'day.run.exitCode': '↳ exited with code {code} (non-blocking).',

  // Section headers
  'day.vcs.section':       'VCS authentication',
  'day.main.section':      'Main branch sync',
  'day.ecosystem.section': 'Ecosystem updates',
  'day.brain.section':     'brain version (core)',
  'day.memory.section':    'Team memory',
  'day.board.section':     'Ticket board',

  // VCS authentication
  'day.vcs.notConfigured':  'VCS provider not configured — set vcs.provider in brain.config.json.',
  'day.vcs.authOk':         'Authenticated ({provider}).',
  'day.vcs.sessionExpired': 'Session not started or expired — re-authenticating from .env...',
  'day.vcs.tokenNotFound':  'Token not found in .env — run brain:env:init',
  'day.vcs.authFailed':     'Auth failed — check the token or that the provider CLI is installed. brain:env:init',

  // Main sync
  'day.main.noVcs':         'Cannot sync main — VCS provider or token not available.',
  'day.main.fetchFailed':   'Fetch of main failed — check connectivity to {host}',
  'day.main.updated':       'main updated (fast-forward applied).',
  'day.main.pullFailed':    'Could not pull main — there may be uncommitted local changes.',
  'day.main.remoteUpdated': 'Remote main updated (active branch: {branch}).',
  'day.main.newCommits':    '{count} new commit(s) in main:',
  'day.main.upToDate':      'main was already up to date.',

  // Ecosystem updates
  'day.ecosystem.notAvailable':    'gentle-ai not available — skipping updates.',
  'day.ecosystem.install':         'Install: npm run tools:install',
  'day.ecosystem.checking':        'Checking versions...',
  'day.ecosystem.allUpToDate':     'All tools up to date.',
  'day.ecosystem.updatesAvailable':'{count} update(s) available:',
  'day.ecosystem.applying':        'Applying updates...',
  'day.ecosystem.done':            'Done.',
  'day.ecosystem.skillRegistry':   'Skill registry updated.',

  // brain version
  'day.brain.unknownInstalled': 'Could not determine installed brain version — skipping check.',
  'day.brain.registryUnreachable': 'Could not reach the registry to check {pkg} — the check was SKIPPED, not passed.',
  'day.brain.notPublished':     '{pkg} has no published release yet.',
  'day.brain.newVersion':       'New brain version available: {installed} → {latest}',
  'day.brain.upgrade':          'Upgrade consciously: {pm} run brain:upgrade -- {latest}',
  'day.brain.noAutoApply':      '(not auto-applied — review the tag changelog first)',
  'day.brain.upToDate':         'brain up to date ({installed}).',

  // Team memory
  'day.memory.hookMissing':    'Pre-push hook missing at {path}/pre-push — feature checkpointing will not run on push.',
  'day.memory.hookActivated':  'Pre-push hook activated (core.hooksPath={hooksPath}).',
  'day.memory.hookFailed':     'Could not activate the pre-push hook (core.hooksPath).',
  'day.memory.hookActive':     'Pre-push hook active — checkpoints feature working memory before push.',
  'day.memory.importing':      'Importing chunks from .memory/ to local DB...',
  'day.memory.reprojecting':   'Reprojecting brain/ to engram...',
  'day.memory.exporting':      'Exporting memory to repo (.memory/)...',
  'day.memory.exported':       'Memory exported to .memory/ — ready to commit with the next push.',
  'day.memory.exportFailed':   'engram export failed — run {pm} run brain:memory:share manually.',
  'day.memory.notAvailable':   'engram not available — skipping shared memory.',
  'day.memory.install':        'Install: gentle-ai install   or   npm run tools:install',

  // Lane sweep (#906, design.md A7) — one line, only when memory.lane.enabled is true.
  'day.memory.laneSweep.running':        'Checking the lane sweep...',
  'day.memory.laneSweep.shipped':        'Lane sweep: shipped {ref} (PR #{number}).',
  'day.memory.laneSweep.reconciled':     'Lane sweep: reconciled {ref} (PR #{number}) — nothing new to push.',
  'day.memory.laneSweep.nothing':        'Lane sweep: nothing to ship.',
  // F2 (cold review, #921/#923): nothing pending, but a worktree could not be
  // inspected — distinct from the plain "nothing to ship" line above, so the
  // operator never mistakes "incomplete inspection" for "confirmed clean".
  'day.memory.laneSweep.worktreeSkipped': 'Lane sweep: nothing to ship, but {count} worktree(s) could not be inspected: {paths}',
  'day.memory.laneSweep.warn':           'Lane sweep: {detail} — see the tmp log; the morning sweep will retry tomorrow.',
  // {detail}'s own text — a key, not a literal, so a non-English docs.language
  // never sees an English word inside a translated line (#906 cold review, editorial).
  'day.memory.laneSweep.detailUnparsed':  'unparseable ship output',
  'day.memory.laneSweep.detailExitCode':  'ship exited {status}',

  // Cross-day lane sweep, per branch (#936, design.md's sweep table) — one
  // line per `outcome.sweep.branches[]` row, rendered by
  // `laneSweepBranchLines()`. `deleted`/`shipped`/`reconciled` are routine
  // (`ok`); the rest need a human's attention (`warn`).
  'day.memory.laneSweep.branch.deleted':        'Lane sweep: {branch} ({date}) was fully delivered — the local branch was deleted.',
  'day.memory.laneSweep.branch.shipped':        'Lane sweep: {branch} ({date}) was re-shipped — pull request #{number}.',
  'day.memory.laneSweep.branch.reconciled':     'Lane sweep: {branch} ({date}) was reconciled — pull request #{number}, nothing new to push.',
  'day.memory.laneSweep.branch.closedUnmerged': '⚠ Lane sweep: {branch} ({date}) was not re-shipped — pull request #{number} was closed without merging; delete the local branch to stop this report.',
  'day.memory.laneSweep.branch.unknown':        '⚠ Lane sweep: {branch} ({date}) has an unreadable state — kept, not guessed.',
  'day.memory.laneSweep.branch.diverged':       '⚠ Lane sweep: {branch} ({date}) diverged from its remote — nothing was forced.',
  'day.memory.laneSweep.branch.failed':         '⚠ Lane sweep: {branch} ({date}) failed to reconcile — {reason}',
  'day.memory.laneSweep.branch.remoteOnly':     '⚠ Lane sweep: {branch} ({date}) exists only on the remote — reported, not mutated.',
  // #936 remediation (cold review WARNING): the sweep as a WHOLE can fail
  // closed (cli.mjs isolates a throw from sweepLanes()'s own pre-loop code —
  // the shared fetch/listLocalBranches/listRemoteBranches/slugifyHost — into
  // this fail-closed marker) — distinct from a per-branch row above, and
  // from `day.memory.laneSweep.warn` (which is about the WHOLE `ship` child
  // process failing to run at all).
  'day.memory.laneSweep.sweepFailed': '⚠ Lane sweep failed — {reason}; nothing changed or reconciled this run.',

  // Done footer
  'day.done.withTicket':      'With a ticket:',
  'day.done.ticketStart':     'brain:ticket:start -- <iid>   (terminal)',
  'day.done.ticketStartAgent':'/ticket-start <iid>             (Claude / AI agent)',
  'day.done.noTicket':        'No ticket — explore or propose:',
  'day.done.sddExplore':      '/sdd-explore <idea>             explore before committing',
  'day.done.gitlabIssue':     '/gitlab-issue                   create an issue from an idea',
  'day.done.beforePush':      'Before pushing:',
  'day.done.checkCmd':        '{pm} run brain:repo:check; capture durable memory with {pm} run brain:memory:save --issue <id> (the enabled memory lane ships it)',

  // ── tracker-board.mjs (PR2) ───────────────────────────────────────────────────
  'tracker.noRemote':        '⚠ Could not detect origin remote.',
  'tracker.vcsNotConfigured':'⚠ VCS provider not configured: {error}',
  'tracker.noSession':       '⚠ No authenticated VCS session for {host} — see https://{host}/{project}',
  'tracker.noUser':          '⚠ Could not get user — only unassigned tickets are shown.',
  'tracker.unassigned':      'Unassigned',

  // ── project-status.mjs (PR2) ──────────────────────────────────────────────────
  'ps.title':             '# Project state — generated projection, DO NOT edit or save',
  'ps.maven.section':     '## Maven Reactor',
  'ps.maven.count':       '{count} module(s) in the reactor (includes aggregators).',
  'ps.maven.orphansTitle':'⚠ Tracked poms OUTSIDE the reactor (not built with backend:build):',
  'ps.maven.missingPom':  '(pom MISSING: {dir})',
  'ps.frontend.section':  '## Frontend (Nx)',
  'ps.frontend.empty':    'No Nx projects yet (empty frontend).',
  'ps.frontend.count':    '{count} Nx project(s).',
  'ps.vcs.section':       '## Open work',
  'ps.vcs.noRemote':      '⚠ Could not detect origin remote.',
  'ps.vcs.notConfigured': '⚠ VCS provider not configured (vcs.provider in brain.config.json).',
  'ps.vcs.noSession':     '⚠ No authenticated VCS session — see https://{host}/{repo}',
  'ps.vcs.issues':        'Open issues ({count}):',
  'ps.vcs.prs':           'Open PRs/MRs ({count}):',
  'ps.vcs.error':         '⚠ Could not query VCS: {message}',
  'ps.footer':            '— End of projection. To regenerate: brain:project:status',

  // ── verify-change.mjs ────────────────────────────────────────────────────────
  'verify.error.rerun':   'Fix and re-run: {pm} run brain:change:verify',

  // ── brain-upgrade.mjs ────────────────────────────────────────────────────────
  'upgrade.error.usage':  'Usage: {pm} run brain:upgrade -- v0.1.0 [--dry-run] [--no-install] [--force]',

  // ── bootstrap.sh (PR3) ───────────────────────────────────────────────────────
  // §1 Base dependencies
  'bootstrap.deps.section': 'Base dependencies',
  'bootstrap.deps.missing': "Missing '{tool}' (required). Install it and re-run brain:env:init.",
  'bootstrap.deps.ok':      'git, python3 present; package manager: {pm}',

  // §2 Ecosystem tools
  'bootstrap.ecosystem.section':  'Ecosystem tools',
  // {tool} = tool name, {hint} = install hint command/URL (always English)
  'bootstrap.ecosystem.notFound': '{tool} not found — {hint}',

  // §3 Personal access token
  'bootstrap.gitignore.ok':     '.env is git-ignored',
  'bootstrap.gitignore.failed': 'could not confirm .env is git-ignored — check .gitignore by hand before committing',

  'bootstrap.pat.section':         'Personal access token (.env)',
  'bootstrap.pat.alreadySet':      '{var} already set in .env',
  'bootstrap.pat.noTty':           'no TTY: add {var} to .env and re-run brain:env:init',
  'bootstrap.pat.openPrompt':      'Open the browser with the pre-filled form? [Y/n]: ',
  'bootstrap.pat.manualUrl':       'Create it manually at: {url}',
  'bootstrap.pat.browserFallback': 'If the browser did not open, go to: {url}',
  'bootstrap.pat.enterPrompt':     'Paste your PAT (not shown): ',
  'bootstrap.pat.skipped':         'No token: skipping VCS authentication. Re-run brain:env:init when you have it.',
  'bootstrap.pat.saved':           '{var} saved in .env (gitignored)',
  'bootstrap.pat.trackedRefused':     '{var} NOT written — .env is already tracked by git, so no .gitignore pattern can protect it. Untrack it first: git rm --cached .env — then re-run brain:env:init.',
  'bootstrap.pat.gitignoreRefused':   '{var} NOT written — could not confirm .env is git-ignored. Fix .gitignore by hand, then re-run brain:env:init.',
  // {var} = token env var name, {target} = the symlink's target path
  'bootstrap.pat.symlinkRefused':          '{var} NOT written — .env is a symlink to {target}; it must be a regular file, or the token would be written outside this repo. Replace it with a regular file, then re-run brain:env:init.',
  'bootstrap.pat.notRegularFileRefused':   '{var} NOT written — .env exists but is not a regular file. It must be a regular file, then re-run brain:env:init.',
  'bootstrap.pat.hardlinkedRefused':       '{var} NOT written — .env is hardlinked to another file, so the token would also land there. Replace it with an independent regular file, then re-run brain:env:init.',
  'bootstrap.pat.settingsNote':            'The non-secret settings (MEMORY_BACKEND, AGENT_PLATFORM, SDD_ENGINE) are still written to .env.',

  // §4 Git credential helper
  'bootstrap.cred.section': 'Git credential helper (HTTPS)',
  'bootstrap.cred.ok':      'push/pull over HTTPS use your personal PAT from .env',

  // §5 VCS authentication
  'bootstrap.auth.section':   'VCS authentication',
  // {host} = VCS host (e.g. github.com)
  'bootstrap.auth.alreadyOk': 'already authenticated against {host}',
  'bootstrap.auth.ok':        'authenticated against {host}',
  'bootstrap.auth.failed':    'auth failed — check the token in .env',
  'bootstrap.auth.noToken':   'No token: VCS remains unauthenticated',

  // §6 SDD harness
  'bootstrap.sdd.section':            'SDD implementation (harness)',
  'bootstrap.sdd.prompt':             'Which SDD implementation do you use? [gentle-ai]: ',
  // {harness} = harness name (e.g. gentle-ai)
  'bootstrap.sdd.ok':                 'harness: {harness} (.env)',
  'bootstrap.sdd.gentleaiMissing':    'gentle-ai missing — brew install gentle-ai and re-run brain:env:init',
  'bootstrap.sdd.ecosystemOk':        'ecosystem already initialized (gentle-ai doctor)',
  'bootstrap.sdd.ecosystemConfigured':'ecosystem configured (skills, engram, gga)',
  'bootstrap.sdd.ecosystemFailed':    'gentle-ai install failed — run it manually and re-run brain:env:init',
  'bootstrap.sdd.noTty':              "no TTY: run 'gentle-ai install' manually",
  'bootstrap.sdd.registryOk':         'skill registry updated',
  'bootstrap.sdd.registryFailed':     'skill-registry refresh failed (non-blocking)',
  // {harness} = unknown harness name
  'bootstrap.sdd.unknownHarness':     "harness '{harness}' has no known init routine — configure its skills manually",
  // no {placeholder} — generic failure from brain/scripts/harness/cli.mjs init
  'bootstrap.sdd.initFailed':         'harness init failed — REQUIRED, env:init will exit 1',
  // ADR gap detection (Step 4 of gentle-ai init)
  'bootstrap.sdd.noProjectAdrs':      'No project ADRs found (brain/project/decisions/ is empty or absent).',
  'bootstrap.sdd.noProjectAdrsHint':  'Run /project:bootstrap-adrs in your AI agent to draft the starter ADR set (Stack, Testing, Build).',

  // §7 Team memory
  'bootstrap.memory.section':        'Team memory',
  'bootstrap.memory.prompt':         'Which memory backend does this team use? (engram|plainfiles): ',
  // {backend} = backend name (e.g. engram)
  'bootstrap.memory.backend':        'memory backend: {backend} ({source})',
  'bootstrap.memory.undeclared':     'no memory backend is declared (env, .env, brain.config.json memory.backend) — none was guessed, so memory setup was skipped. Next: npm run brain:config -- set memory.backend engram|plainfiles, then re-run env:init.',
  'bootstrap.memory.invalid':        "memory backend '{value}' (from {source}) is not 'engram' or 'plainfiles' — memory setup skipped. Fix it where it is set, then re-run env:init.",
  'bootstrap.memory.unreadable':     "could not read brain.config.json, so no memory backend could be resolved — {detail}. Nothing was prompted or written; fix or restore the file, then re-run env:init.",
  'bootstrap.memory.resolverFailed': "the memory backend resolver failed (exit {code}) — that is the check failing, not a backend being undeclared. Nothing was prompted or written.",
  'bootstrap.memory.declared':       'memory backend saved to brain.config.json (memory.backend) — commit it so every checkout runs the same backend',
  'bootstrap.memory.declareFailed':  'could not write memory.backend to brain.config.json — set it with: npm run brain:config -- set memory.backend {backend}',
  'bootstrap.memory.envOnly':        'memory backend {backend} comes only from this machine\'s .env — teammates and fresh clones will not see it. To share it with the team: npm run brain:config -- set memory.backend {backend}',
  'bootstrap.memory.envShadows':     'the {source} value ({backend}) overrides brain.config.json memory.backend ({configured}) on this machine',
  'bootstrap.memory.hookOk':         'pre-push hook activated (checkpoints feature working memory before push — ADR-0003)',
  'bootstrap.memory.hookFailed':     'could not activate core.hooksPath (pre-push hook)',
  'bootstrap.memory.nodeAbsent':     'node absent — engram backend setup skipped',
  'bootstrap.memory.engram.ok':      'engram backend configured (symlink + merge driver)',
  'bootstrap.memory.engram.failed':  'memory setup failed — REQUIRED, env:init will exit 1',
  'bootstrap.memory.pull.ok':        'memory imported (.memory/ → engram)',
  'bootstrap.memory.pull.failed':    'brain:memory:pull failed — REQUIRED, env:init will exit 1',
  'bootstrap.memory.pull.skipped':   'memory pull skipped — {reason}. Next: npm run brain:memory:pull once that is in place.',
  'bootstrap.memory.pull.noCommits': 'this repository has no commits yet',
  'bootstrap.memory.pull.noUpstream': 'this branch has no upstream to pull from',
  'bootstrap.memory.pull.offline':   'the remote could not be reached',
  'bootstrap.memory.engramAbsent':   'engram is not installed — hydration and indexing skipped (records-only capture still works). Next: install engram, then npm run brain:memory:pull && npm run brain:memory:index.',
  'bootstrap.memory.index.ok':       'durable index reprojected (brain/ → engram)',
  'bootstrap.memory.index.failed':   'brain:memory:index failed — REQUIRED, env:init will exit 1',
  'bootstrap.memory.plainfiles.ok':      'plainfiles backend ready (.memory/records/ + index)',
  'bootstrap.memory.plainfiles.failed':  'plainfiles memory setup failed — REQUIRED, env:init will exit 1',
  'bootstrap.memory.plainfiles.noIndex': 'brain/ → memory indexing is engram-only; plainfiles has no doc projection by design',
  // {backend} = unknown backend name
  'bootstrap.memory.unknownBackend': "backend '{backend}' has no known init routine — configure it manually",

  // §8 Ticket board  — {path} = PROJECT_PATH, {host} = VCS_HOST
  'bootstrap.board.section': 'Open tickets in {path}',
  'bootstrap.board.failed':  'could not list tickets — see https://{host}/{path}',

  // §9 Done
  'bootstrap.done.section': 'Environment ready',
  // {tools} = space-separated list of missing optional tools
  'bootstrap.done.pending': 'Pending: {tools}',
  'bootstrap.done.install': 'Run: npm run tools:install  (installs all at once)',
  // {items} = space-separated list of required-but-failed steps
  'bootstrap.done.requiredFailed': '✗ Required step(s) failed: {items} — env:init did NOT complete successfully.',

  // ── lib/tier-notice.mjs — env:init states the governance tier (#1124) ─────────
  // {tier} = lite | standard | regulated
  'config.tier.new':       'governance tier: {tier} — set for this new repository (governance.tier in brain.config.json).',
  'config.tier.declared':  'governance tier: {tier} — already declared in brain.config.json; left unchanged.',
  'config.tier.absent':    'governance tier: standard — brain.config.json declares none, and an absent tier resolves to standard; left unchanged.',
  // {tier} = the unrecognised value, {tiers} = the valid tiers, comma-separated
  'config.tier.invalid':   'governance.tier "{tier}" in brain.config.json is not a tier ({tiers}) — every gate that reads it fails closed until it is fixed.',
  'config.tier.why.lite':  'lite is for one maintainer: no second approval is required to merge, and every gate still runs.',
  'config.tier.why.standard':  'standard is for a team: a merge needs a second, non-author approval.',
  'config.tier.why.regulated': 'regulated is for audited work: the strictest evidence, and no waivers.',
  'config.tier.change':    'To change it, set governance.tier in brain.config.json to lite, standard (a team: a second, non-author approval) or regulated (audited: the strictest evidence, no waivers) — e.g. npm run brain:config -- set governance.tier standard — then re-run npm run brain:protect.',
  'config.lane.on':        'memory lane: on — memory records ship to main on their own pull request (memory.lane.enabled in brain.config.json).',
  'config.lane.off':       'memory lane: off — memory records stay in your clone; nothing ships them to main for you.',
  'config.lane.why':       'The lane is off by default on every tier because it opens a separate pull request for memory records that a maintainer has to merge; turning it on is a deliberate choice.',
  'config.lane.enable':    'To turn it on: npm run brain:config -- set memory.lane.enabled true',

  // ── install-tools.sh (PR3) ────────────────────────────────────────────────────
  // Pre-check (before eval — inline English default used in the script)
  'tools.require.noApt': 'This script requires apt-get (Ubuntu/Debian). Install the tools manually following brain/project/methodology/developer-environment.md.',

  // skip() helper — "already installed" suffix
  'tools.installed': 'already installed',

  // §1 apt packages — {pkgs} = space-separated package list
  'tools.apt.section':    'System packages (apt)',
  'tools.apt.installing': 'Installing: {pkgs}',
  'tools.apt.ok':         'apt: {pkgs}',
  'tools.apt.allPresent': 'all apt packages already present',

  // §1b VCS CLI — {cli} = cli binary name (gh / glab)
  'tools.vcs.section':   'VCS CLI ({cli})',
  'tools.vcs.installed': '{cli} installed',
  'tools.vcs.notInApt':  '{cli} is not in apt — install it manually:',

  // §2 Node.js — {version} = node version string
  'tools.node.installing': 'Installing nvm...',
  'tools.node.nvmOk':      'nvm installed',
  'tools.node.nodeOk':     'node {version} via nvm',
  'tools.node.reloadShell':'Open a new terminal or run: source ~/.bashrc',

  // §3 Claude Code
  'tools.claude.section':    'Claude Code (Anthropic CLI)',
  'tools.claude.installed':  'claude installed',

  // §4 gentle-ai
  'tools.gentleai.section':          'gentle-ai + ecosystem (engram, gga)',
  'tools.gentleai.installing':       'Installing gentle-ai...',
  'tools.gentleai.ok':               'gentle-ai installed',
  'tools.gentleai.alreadyConfigured':'gentle-ai ecosystem already configured',
  'tools.gentleai.configuring':      'Configuring ecosystem (engram, gga, skills)...',
  'tools.gentleai.configured':       'ecosystem configured',
  'tools.gentleai.configFailed':     'gentle-ai install failed — retry manually',

  // §5 Summary — {tool} = binary name
  'tools.summary.incomplete':    'Setup INCOMPLETE — failed steps: {steps}. Fix the errors above and re-run.',
  'tools.summary.section':       'Installation complete',
  'tools.summary.nextStep':      'Next step:',
  'tools.summary.checkVersions': 'Check versions:',
  'tools.summary.notFound':      '{tool}  (not found — restart the terminal)',

  // ── ticket-start.mjs (PR2) ────────────────────────────────────────────────────
  'ticket.error.baseRequiresArg': '✗ --base requires a branch name. Example: --base feature/issue-99-my-story',
  'ticket.error.usage':           'Usage: brain:ticket:start -- <issue-id> [--worktree] [--base <branch>] [--off-tracker]',
  'ticket.error.usageExample1':   'Example: brain:ticket:start -- 42',
  'ticket.error.usageExample2':   '         brain:ticket:start -- 42 --worktree --base feature/issue-99-my-story',
  'ticket.error.noRemote':        '✗ Could not detect origin remote.',
  'ticket.error.vcsInit':         '✗ Could not initialize VCS: {message}',
  'ticket.error.tokenNotFound':   '✗ VCS token not found in .env — run brain:env:init',
  'ticket.fetching':              'Searching for issue #{id}...',
  'ticket.error.fetchFailed':     '✗ Could not get issue #{id} — check VCS session and ID. {message}',
  'ticket.error.notFound':        '✗ Issue #{id} not found in {project}',
  'ticket.labels':                'Labels: {labels}',
  'ticket.branch':                'Branch: {branch}',
  'ticket.updatingBase':          'Fetching origin/{base} (the branch this task starts from)...',
  'ticket.staleCheckout':          '⚠ This checkout is BEHIND origin/{branch} ({head} → {base}), and brain/scripts/ differs.',
  'ticket.staleCheckoutHint':      '    You may be running an older version of this verb. To update: git -C {root} merge --ff-only origin/{branch}',
  'ticket.error.fetchBase':       '✗ Could not fetch base branch \'{branch}\' from remote.',
  'ticket.error.fetchBaseHint':   '    Does it exist and is it pushed? Check the name.',
  'ticket.error.worktreeExists':  '✗ Worktree folder already exists: {path}',
  'ticket.error.worktreeExistsHint': '    Remove it (git worktree remove) or use a different issue.',
  'ticket.error.worktreeCreate':  '✗ Error creating worktree: {error}',
  'ticket.worktreeCreated':       '✓ Worktree created at {path}',
  'ticket.envCopied':             '✓ .env copied to worktree.',
  'ticket.noEnv':                 '→ No .env at {root} — skipping copy.',
  'ticket.branchExists':          '→ Branch already exists — switching to it...',
  'ticket.error.branchCreate':    '✗ Error creating branch: {error}',
  'ticket.branchCreated':         '✓ Branch created and active.',
  'ticket.mode.worktree':         'Isolated worktree (the default — harness-contract.md requires it for parallel work).',
  'ticket.mode.inPlace':          'IN-PLACE branch in the main checkout — allowed only for strictly solo, serial work. No other agent can work in parallel while this branch is checked out here.',
  'ticket.error.contradictoryModes': 'both --worktree and --in-place were given. Refusing rather than picking one: ask for one mode.',

  // ── ticket-start.mjs — the base comes from the epic (#967) ──────────────────
  // Every one of these SAYS the reason. A base the operator did not choose and
  // cannot account for is how a slice ends up on the wrong branch quietly.
  'ticket.base.fromEpic':         '→ Base: {tracker} — declared by epic #{epic} (parent read from the {source}).',
  'ticket.base.noEpic':           '→ Base: {base} — no epic tracker applies (reason: {reason}).',
  'ticket.base.epicUnreadable':   '→ Base: {base} — epic #{epic} could not be read, continuing anyway: {message}',
  'ticket.base.offTracker':       '→ Base: {base} — OFF TRACKER: epic #{epic} declares {tracker}, and --off-tracker was given.',
  'ticket.error.baseIsTracked':   '✗ --base {base} was given, but epic #{epic} declares tracker {tracker} — while that epic is in flight a slice starts there. Use --base {tracker}, or pass {flag} to state that this branch deliberately does not.',

  'ticket.error.noTypeLabel':     '✗ Issue #{id} has no type:* label (labels found: [{labels}]) — brain:ship would refuse it later. Add one on the issue now (for example type:feature, type:bug or type:chore; type::feature on GitLab), then re-run.',

  'ticket.nextSteps.header':      'Next steps:',
  'ticket.nextSteps.cd':          '    0. cd {path}   (open your work session here)',
  'ticket.nextSteps.step1':       '    1. Implement — use /sdd-new {id} if the change is complex',
  'ticket.nextSteps.step2':       '    2. {pm} run brain:repo:check before each commit',
  'ticket.nextSteps.step3':       '    3. Capture durable memory with {pm} run brain:memory:save --issue {id}; the enabled memory lane ships it before pushing',
  'ticket.nextSteps.step4':       '    4. git push -u origin {branch}',

  // ── ticket-start.mjs — feature working memory (Slice 3) ─────────────────────
  'ticket.resume.noContext': '→ No feature resume context found — continuing.',

  // ── session-start.mjs (issue #138, PR3) ───────────────────────────────────────
  // Resolved ONCE (as templates, placeholders intact) in session-start.mjs's CLI
  // entry via t(), then interpolated synchronously by the pure renderContextBlock
  // (design §1.8). {branch}/{change}/{count}/{list} are filled at render time.
  'session.header':             'brain · session context',
  'session.branch':             'branch:   {branch}',
  'session.branch.unknown':     '(unknown)',
  'session.change.one':         'change:   {change}',
  'session.change.none':        'change:   (no change folder for branch)',
  'session.change.ambiguous':   'change:   ambiguous ({count}): {list}',
  'session.memory.ok':          'memory:   engram hydrated',
  'session.memory.skip':        'memory:   engram unavailable (skipped)',
  // #923 — the hydration failure cause, when available (see step2HydrateEngram).
  'session.memory.notDeclared': "memory:   hydration skipped, nothing was tried — {reason}",
  'session.memory.skip.reason': 'memory:   engram unavailable (skipped) — {reason}',
  'session.memory.recency.stale':   'memory:   newest durable record is {days} days old — nothing captured since (see #519)',
  'session.memory.recency.unknown': 'memory:   no durable record found — cannot determine when memory was last captured',
  'session.ticket.label':       'ticket:',
  'session.ticket.none':        '(no active ticket memory)',

  // ── memory/cli.mjs — reindex (issue #205, C1) ─────────────────────────────────
  'memory.audit.failed':   '✗ audit could not run — {message}',
  'memory.audit.badSince': '✗ audit: --since is not a date — {value}',
  'memory.reindex.done':   '✓ reindex complete — {count} record(s) indexed.',
  'memory.reindex.failed': '✗ reindex failed — {message}',
  'memory.resolveIndex.done':   '✓ index regenerated from records/ — {count} record(s). Nothing was unmerged, so nothing was staged.',
  'memory.resolveIndex.staged': '✓ index conflict resolved — {count} record(s) regenerated from records/ and staged. Finish the merge with `git commit`.',
  'memory.resolveIndex.failed': '✗ resolve-index failed — {message}',

  // ── memory/lib/duplicates.mjs — formatDuplicateReport() (issue #574, promoted #638) ──
  'memory.duplicates.summary': '⚠ {ids} duplicate record id(s) in .memory/records/ — {lines} excess physical line(s) collapsed into {surface}.',
  'memory.duplicates.summaryWithIndex': '⚠ {ids} duplicate record id(s) in .memory/records/ — {lines} excess physical line(s) collapsed into {surface} ({total} physical line(s) → {indexCount} indexed).',
  'memory.duplicates.why': '  Deduplicated, not refused: `merge=union` concatenates both copies when two branches hold the same record (ADR-0017, REQ-MF-3), so this is the transport working, not a corrupt store — but `wc -l .memory/records/*.jsonl` over-counts the store by {lines}, and it is only reported because you are reading this.',
  'memory.duplicates.divergent': '  {count} of them DISAGREE outside the hashed fields (`source` is not hashed, so two copies of one record can differ there — brain\'s own export→import→export widens it). Resolved first-wins: the earliest line of the earliest month file is the one indexed, exactly as the read path resolves it. Marked [divergent] below — worth a look, not an error.',
  'memory.duplicates.brief': '  Run `npm run brain:memory:reindex` for the per-id locations.',
  'memory.duplicates.group': '  {id} ×{count} — {locations}',
  'memory.duplicates.groupDivergent': '  {id} ×{count} [divergent] — {locations}',
  'memory.duplicates.moreOccurrences': ', +{count} more',
  'memory.duplicates.moreGroups': '  … +{count} more duplicated id(s).',
  'memory.duplicates.unknownId': '(unknown id)',

  // ── memory/cli.mjs — split-records (issue #677) ──────────────────────────────
  'memory.splitRecords.plan':    'plan — {lines} record line(s) across {months} month file(s) become {writes} per-record file(s). NOTHING was written. Re-run with --apply to perform it.',
  'memory.splitRecords.done':    '✓ split complete — {written} record file(s) written, {alreadyPresent} already present, {months} month file(s) removed after verifying every record reads back.',
  'memory.splitRecords.nothing': 'nothing to split — no <yyyy-mm>.jsonl month file under .memory/records/ ({alreadySplit} per-record file(s) already there).',
  'memory.splitRecords.repeats': '{count} repeated line(s) collapsed first-wins ({divergent} divergent — same id, different bytes). The winner is the line the readers already resolved to.',
  'memory.splitRecords.failed':  '✗ split-records failed — {message}',

  // ── memory/cli.mjs — heal-duplicates (#1061, #864 task 1.2a) ─────────────────
  'memory.heal.none':               'nothing to heal — {rows} live rec- row(s), {distinct} distinct key(s).',
  'memory.heal.plan':               'plan — {count} duplicate key(s) found. NOTHING was deleted. Re-run with --apply to perform it.',
  'memory.heal.deleted':            '✓ deleted {count} row(s): {ids}.',
  'memory.heal.done':               '✓ heal verified — {rows} live rec- row(s), {distinct} distinct key(s).',
  'memory.heal.partial':            '✗ heal stopped after a failed delete — deleted {deleted}, not deleted {notDeleted} ({detail}). Nothing else was touched; re-run once the cause is fixed.',
  'memory.heal.unverified':         '✗ heal could not be verified — {deleted} row(s) were deleted but a fresh export still shows a duplicate. Nothing further was deleted.',
  'memory.heal.notEngram':          "heal-duplicates only applies to the 'engram' backend, not '{backend}'. Nothing was deleted.",
  'memory.heal.badFlag':            "unknown flag '{flag}'. Only --apply is accepted. Nothing was deleted.",
  'memory.heal.failed':             '✗ heal-duplicates failed — {message}',
  'memory.heal.refused.divergent':  "refused — '{key}' has copies that differ in {fields}. Nothing was deleted.",
  'memory.heal.refused.tooMany':    "refused — '{key}' has {count} live rows, more than the two this heal understands. Nothing was deleted.",
  'memory.heal.refused.shape':      'refused — the export is not in a shape this heal understands ({detail}). Nothing was deleted.',
  'memory.heal.refused.version':    'refused — {detail}. Nothing was deleted.',

  // ── memory/cli.mjs — collect (issue #887, ADR-0034 L4/C2) ────────────────────
  'memory.collect.done':    '✓ collected {collected} record(s) into {ref} ({commit}).',
  'memory.collect.nothing': 'nothing new to collect — {ref} unchanged.',
  'memory.collect.offline': 'origin/main could not be fetched; continued on the local origin/main ref.',
  'memory.collect.failed':  '✗ collect failed — {message}',
  'memory.collect.badHost': '✗ collect failed — the host name produced an empty or invalid ref slug: {message}',
  'memory.collect.raced':   '✗ collect failed — the lane ref moved during this run (raced); nothing was lost, its blobs are re-collected on the next run: {message}',
  'memory.collect.secretSkipped':          '{count} secret-bearing record(s) skipped — pattern and line number only, never the matched line.',
  'memory.collect.modifiedTrackedSkipped': '{count} tracked-and-modified record(s) skipped — commit or stash them, then re-run.',
  // #921 — an unreadable worktree is a distinct fact from "nothing pending"; surfaced by count + path, never silently dropped.
  'memory.collect.worktreeSkipped': '{count} worktree(s) could not be inspected and were excluded from this run: {paths}',

  // ── memory/cli.mjs — ship (issue #888, ADR-0034 L1/L2/L5) ────────────────────
  'memory.ship.done':             '✓ shipped {ref} — pull request #{number} is armed.',
  'memory.ship.reconciled':       '✓ reconciled {ref} — pull request #{number} is armed. Nothing new was pushed.',
  'memory.ship.nothing':          'nothing new to ship — {ref} already matches origin.',
  'memory.ship.dryRun':           'plan — {ref} would ship. Nothing was pushed, no port call was made.',
  'memory.ship.pushed':           '✓ pushed {ref} to origin.',
  'memory.ship.prExisting':       'pull request #{number} was already open — reused, not recreated.',
  'memory.ship.armed':            '✓ auto-merge armed on pull request #{number}.',
  'memory.ship.autoMergeRefused': 'auto-merge was refused ({reason}) — the pull request stays open; the next run re-arms it.',
  'memory.ship.identityAmbient':  'BRAIN_MEMORY_TOKEN is not set — this run authenticated with the ambient session credential.',
  'memory.ship.diverged':         '✗ ship failed — {ref} diverged from origin; nothing was forced. {message}',
  'memory.ship.pushFailed':       '✗ ship failed — the push did not land. {message}',
  // #1119: this lookup runs before the push (D4) — a failure here means
  // nothing was pushed, not that the push landed. Retrying is safe: the
  // next run starts over from the same unpushed state.
  'memory.ship.prLookupFailed':   '✗ ship failed — the pull request lookup could not run, so its existence is uncomputable; nothing was pushed this run. Retry once the lookup succeeds. {message}',
  // #1119: distinct from `prLookupFailed` above — this is the one-shot
  // re-scan that only runs AFTER the push already landed, so unlike the
  // pre-push lookup failure, the push here is real and durable.
  'memory.ship.prLookupFailedAfterPush': '✗ ship failed — the push already landed, but the pull request could not be found afterward to confirm its number. Retry is safe — the next run reconciles it. {message}',
  'memory.ship.prCreateFailed':   '✗ ship failed — the pull request could not be created. {message}',
  'memory.ship.prNumberUnknown':  'the pull request is open but its number could not be derived — auto-merge was skipped; the next run recovers it.',
  // R8 REVERSAL (#920 -> #936, D4): a branch whose only pull request was
  // closed unmerged is never re-pushed and never given a fresh PR — it is
  // reported instead, on every run, until an operator deletes the local ref.
  'memory.ship.closedUnmerged':   '⚠ {branch} was not shipped — pull request #{number} was closed without merging; it will keep being reported on every run until the local branch is deleted.',
  'memory.ship.failed':           '✗ ship failed — {message}',
  'memory.ship.raced':            '✗ ship failed — the lane ref moved during this run (raced); nothing was lost, its blobs are re-collected on the next run: {message}',
  'memory.ship.badHost':          '✗ ship failed — the host name produced an empty or invalid ref slug: {message}',
  'memory.ship.invokerMissing':   '✗ ship refused — pass --invoker hook, sweep, or manual; to run it by hand use `npm run brain:memory:ship`.',
  'memory.ship.invokerUnderTest': '✗ ship refused — NODE_TEST_CONTEXT is set; a test must use BRAIN_VCS_TEST_MODULE or --dry-run, never a bare --invoker.',
  'memory.ship.invokerInvalid':   '✗ ship refused — --invoker must be hook, sweep, or manual; got {value}.',

  // Cross-day lane sweep, per branch, on stderr (#936, D-sweep step 5.8) —
  // never gated by --json, same discipline as memory.ship.pushed/prExisting/
  // armed/identityAmbient above. Same 8 actions as day.memory.laneSweep.branch.*.
  'memory.ship.sweep.deleted':        'lane sweep: {branch} ({date}) was fully delivered — the local branch was deleted.',
  'memory.ship.sweep.shipped':        'lane sweep: {branch} ({date}) was re-shipped — pull request #{number}.',
  'memory.ship.sweep.reconciled':     'lane sweep: {branch} ({date}) was reconciled — pull request #{number}, nothing new to push.',
  'memory.ship.sweep.closedUnmerged': 'lane sweep: {branch} ({date}) was not re-shipped — pull request #{number} was closed without merging.',
  'memory.ship.sweep.unknown':        'lane sweep: {branch} ({date}) has an unreadable state — kept, not guessed.',
  'memory.ship.sweep.diverged':       'lane sweep: {branch} ({date}) diverged from its remote — nothing was forced.',
  'memory.ship.sweep.failed':         'lane sweep: {branch} ({date}) failed to reconcile — {reason}',
  'memory.ship.sweep.remoteOnly':     'lane sweep: {branch} ({date}) exists only on the remote — reported, not mutated.',
  // #936 remediation: mirrors day.memory.laneSweep.sweepFailed above — the
  // sweep as a WHOLE failed closed, no `branches` rows exist to iterate.
  'memory.ship.sweepFailed':          'sweep failed: {reason}, nothing changed or reconciled this run.',

  // ── memory/cli.mjs — which backend actually ran (issue #641) ─────────────────
  // Each of these is a case where the backend that ran is not the one a reader
  // would assume. Silence is the whole defect: `MEMORY_BACKEND=plainfiles`
  // worked all along, and because nothing ever said so, the engram-only error
  // read as "capture is impossible here".
  // #1165: an undeclared/invalid selector is refused with the fix named, never guessed.
  'memory.backend.undeclared': "no memory backend is declared, so `{op}` will not guess one. The team's choice belongs in tracked config: `npm run brain:config -- set memory.backend engram` (or `plainfiles`). Per-run override: MEMORY_BACKEND=<backend> (env or .env). Or run `npm run brain:env:init`, which asks once and writes it.",
  'memory.backend.invalid': "memory backend '{value}' (from {source}) is not one of: {allowed}. Nothing was run. Fix it where it is set: `npm run brain:config -- set memory.backend <backend>` for the team's config, or the MEMORY_BACKEND line in .env.",
  'memory.backend.saveDeferred.undeclared': "nothing declares a memory backend, so this record was saved to .memory/records/ only — hydration into a backend is deferred until one is declared (`npm run brain:config -- set memory.backend engram|plainfiles`). The record is durable; nothing was lost.",
  'memory.backend.saveDeferred.invalid': "the declared memory backend '{value}' is not a backend, so this record was saved to .memory/records/ only — hydration is deferred until it is fixed (`npm run brain:config -- set memory.backend engram|plainfiles`). The record is durable; nothing was lost.",
  'memory.backend.shadowed': "the memory backend from {winner} ({backend}) overrides {loser} ({other}) on this run.",
  'memory.backend.substituted': "the `{from}` binary is not installed here, so `{op}` ran on the records-only `{fallback}` backend instead — same records, same validation, no backend required (ADR-0017). {source} still declares `{from}`, and that is unchanged: hydration into `{from}` is deferred until it is installed, then re-run `npm run brain:memory:{op}`.",
  'memory.backend.statedButAbsent': "{source} sets the memory backend to {backend} explicitly, but the `{backend}` binary is not on PATH here — a stated selector is never overridden (ADR-0004), so this run will fail. Records-only capture needs no backend: `MEMORY_BACKEND={fallback} npm run brain:memory:{op}`.",
  'memory.backend.probeFailed': 'could not determine whether the `{backend}` binary is present — {reason}. That is the CHECK failing, not the binary being absent, so nothing was substituted and `{op}` continues on `{backend}`. If it fails, the records-only route is `MEMORY_BACKEND={fallback} npm run brain:memory:{op}`.',

  // ── axes/memory/adapters/engram.mjs — share() secret scrub (issue #214, C1b) ──────
  'memory.share.unprovenanced': '{count} observation(s) arrived with no provenance block, so they materialised as `@legacy` with no `issue` — nothing emits the block on the capture path yet (#541). Counted, not refused: refusing would reject the store that already exists.',
  'memory.share.skippedHydrated': '{count} observation(s) were skipped — their topic already named a record (written by hydrate(), #874), so re-exporting them would have minted a duplicate id.',
  'memory.share.secretFound': 'Secret detected in {file}:{line} — pattern "{pattern}" matched. Redact the secret, or add an allowlist entry in governance.memorySecretAllowPatterns if this is a false positive. Run `gunzip -c {file} | jq .` to inspect (the line number is against that pretty-printed view).',

  // ── axes/memory/adapters/engram.mjs — the records dual-write exporter's upstream-base
  // export scope (issue #701). Orphaned since #874 split B along with the rest of
  // `memory.share.*` (D6) — the exporter itself is gone too now (#955 R5, epic
  // task 2.4), so these keys have no reader left. Left in place: no ruling covers
  // deleting orphaned catalog keys, only the code that produced them.
  // No `{ref}` slot: this fires on every unavailable lookup, including the one
  // where NO ref resolved and there is therefore no ref to name. `{reason}`
  // names the ref itself wherever one was involved.
  'memory.share.upstreamUnavailable': 'could not check the upstream base — {reason}. This run wrote every candidate (the pre-#701 behaviour); nothing was scoped.',
  'memory.share.upstreamConfigUnreadable': '{error}. Any memory.upstreamRef stated there was NOT honored — the upstream base was derived as {ref} instead. Fix brain.config.json (a mid-merge conflict marker is the usual cause) if you meant to scope against a different ref.',
  // The same fact when NOTHING resolved. The key above names a derived ref,
  // which is only true when one answered; on this branch there is no ref at all
  // (`upstream-records.mjs` returns `null`), and the key above used to name the
  // invented `origin/main` one line before the next line said nothing had
  // resolved (cold review round 2 of #701). The "next line" it points at is
  // memory.share.upstreamUnavailable, which always follows on this branch.
  'memory.share.upstreamConfigUnreadableNoRef': '{error}. Any memory.upstreamRef stated there was NOT honored, and no upstream base resolved either — see the next line for what was tried. Fix brain.config.json (a mid-merge conflict marker is the usual cause) if you meant to scope against a different ref.',
  'memory.share.upstreamUnnamed': '{count} file(s) under .memory/records/ at the upstream base do not match the per-record filename shape and are invisible to the export-scope check. Run `npm run brain:memory:split-records` to fix.',
  'memory.share.dedupedUpstream': '{count} record(s) already present on the upstream base ({ref}) were not re-exported.',

  // ── memory/staged-records-check.mjs — pre-commit gate (issue #701) ───────────
  'memory.stagedRecordsCheck.refused': 'refusing — {count} staged .memory/records/ file(s) are byte-identical to a copy already on the trunk. This adds nothing and is what re-triggers this ticket. The remedy is lossless — the bytes are already durable upstream:',
  'memory.stagedRecordsCheck.mergeUnreadable': 'a merge IS in progress but its parents could not be read — {error}. Records this merge is carrying in cannot be told apart from a re-commit, so the verdict below is the pre-merge one. Do NOT `rm` a record the merge introduced on the strength of it.',
  'memory.stagedRecordsCheck.remedy': '  git restore --staged {paths}\n  (then `rm` any of those paths that `git status` now shows as untracked — same bytes, already on the trunk)',
  'memory.stagedRecordsCheck.unavailable': 'could not check the upstream base — {note}. Nothing was refused; this run could not ask the question.',
  'memory.stagedRecordsCheck.configUnreadable': '{error}. Any memory.upstreamRef stated there was NOT honored — the upstream base was derived as {ref} instead. Fix brain.config.json (a mid-merge conflict marker is the usual cause) if you meant to scope against a different ref.',
  // See memory.share.upstreamConfigUnreadableNoRef — the same split, at the gate.
  'memory.stagedRecordsCheck.configUnreadableNoRef': '{error}. Any memory.upstreamRef stated there was NOT honored, and no upstream base resolved either — see the next line for what was tried. Fix brain.config.json (a mid-merge conflict marker is the usual cause) if you meant to scope against a different ref.',

  // ── axes/memory/adapters/engram.mjs — importMemory() records-only pull (D2/C4, issue #229) ──
  'memory.import.empty':    'ℹ no records found in .memory/records/ — nothing to import.',
  'memory.import.progress': '  ✓ {written}/{total} records imported',
  'memory.import.done':     '✓ import complete — {written}/{total} records imported into engram (records-only, D2/C4).',
  'memory.import.contended': '⚠ another hydration is running (pid {pid}, started {age}s ago) — import SKIPPED so records are not duplicated. Nothing was written; the next run retries.',
  'memory.import.stateUnreadable': '⚠ engram\'s current state could not be read — import SKIPPED so records are not duplicated. Reason: {reason}. Nothing was written; run the import again once engram responds.',

  // ── memory/cli.mjs — migrate-v1 (issue #217, C2a / #219 C2-migrate / #222 C2b-2) ──
  'memory.migrateV1.realRunSummary':        '✓ migration complete — written: {written} | rejected: {rejected} | skipped (personal): {skipped} | unparseable chunks: {unparseable} | empty-observations chunks: {emptyObservations} | index: {indexCount} record(s). records/ is now the sole write path (memory.dualWrite retired, D3/C4).',
  'memory.migrateV1.rollbackRetired':       'migrate-v1 --rollback was retired (#955): it used to restore v1 chunks from .memory/legacy/ and then delete .memory/records/, destroying every record captured since the migration. This refusal reads and writes nothing — the v1 chunks are wherever they already were: still in .memory/legacy/ if that directory exists locally, or in git history otherwise: git show <sha>:.memory/legacy/<file>',
  'memory.migrateV1.dryRunHeader':          'Dry-run migration report (issue #217, C2):',
  'memory.migrateV1.summary':               'records: {records} | skipped (personal): {skipped} | rejected: {rejected} | unparseable chunks: {unparseable} | empty-observations chunks: {emptyObservations}',
  'memory.migrateV1.typesHistogramHeader':  'Types histogram:',
  'memory.migrateV1.provenanceHistogramHeader': 'Provenance histogram: {recovered} recovered / {fallback} fallback',
  'memory.migrateV1.rejectedHeader':        'Rejected records:',
  'memory.migrateV1.emptyObservationsHeader': 'Sessions/prompts-only chunks (observations: null — not corruption, 0 contributed):',
  'memory.migrateV1.unparseableHeader':     'Unparseable chunk files (genuinely corrupt — observation count unknown):',

  // ── memory/lib/unsupported-op.mjs — the shared never-cryptic deferral helper (C3, issue #246) ──
  'memory.op.unsupported':            "op '{op}' is not supported by the '{backend}' memory backend (deferred — see openspec/changes/issue-246-c3).",
  // memory.save.engramUnsupported retired at #874, split A (D7) — its only call
  // site (engram.mjs#save) is now the record-first producer path.
  'memory.search.engramUnsupported':  "'{op}' is not a cli verb for the '{backend}' backend — use engram's native mem_search / 'engram search' instead.",

  // ── axes/memory/adapters/plainfiles.mjs — save/search CLI verbs (C3, issue #246) ──
  'memory.plainfiles.save.issueInvalid': '--issue must be an issue NUMBER; got {value}. It is stored as an integer so a record can be tied to its ticket.',
  'memory.plainfiles.save.typeRequired': '--type is required and has no safe default — it is a choice, not a fact the tool can derive. One of: {types}.',
  'memory.plainfiles.save.done':    "✓ saved {id} → {file}",
  // #637 — the index rebuild is the ONE gate that cannot run before the append,
  // so its failure is never a refusal: the record is already durable. Saying
  // "save() failed" sent the operator to the single action that makes it worse.
  'memory.plainfiles.save.indexFailed': 'the record WAS written — {id} → {file}. What failed is the INDEX rebuild, which reads the whole store, so the cause is almost certainly a record that was already broken before this run: {message}\n  Do NOT run brain:memory:save again — the record is already on disk, and a retry mints a SECOND record with a later `ts`, hence a different id, which no deduplication will ever collapse.\n  Repair the store, then rebuild the index with `npm run brain:memory:reindex`.',
  'memory.plainfiles.save.secretFound': 'Secret detected in the candidate record (line {line}) — pattern "{pattern}" matched. Aborted BEFORE the records/ append (add an allowlist entry in governance.memorySecretAllowPatterns if this is a false positive).',
  // ── #738 — provenance at capture: actor/actorKind/issue ──────────────────
  'memory.plainfiles.save.actorUnset': 'no configured actor — run `git config --local brain.actor @<handle>` once per clone, then retry. brain.actor is unset.',
  'memory.plainfiles.save.actorMalformed': "brain.actor is set to '{value}', which is not handle-shaped (must start with @, e.g. @yourhandle). Run `git config --local brain.actor @<handle>` to fix it.",
  'memory.plainfiles.save.actorReserved': "brain.actor is set to '{value}', a reserved value used internally for unattributed/legacy records — it cannot be used as a capture actor. Run `git config --local brain.actor @<handle>` with your own handle.",
  'memory.plainfiles.save.issueDerived': 'issue {issue} derived from branch {branch} (no --issue given).',
  'memory.save.plainfilesIgnoredOpts': 'ignored option(s) {opts} — the plainfiles record format has no field for them (scope/topic are engram-only concepts); the record was still written normally.',
  'memory.save.engramIgnoredOpts': "ignored option(s) {opts} — hydrate always sets its own scope ('project') and topic (the record's own id); the values passed here were discarded, not merged, and the record was still written normally.",
  // ── --supersedes (#805): a supersedes id is checked against the store, local first, before any write ──
  'memory.plainfiles.save.supersedesMalformed': "--supersedes '{value}' is not shaped rec-<16 hex chars> — refused before any filesystem or git call, and no record was written.",
  'memory.plainfiles.save.supersedesNotInStore': "--supersedes {id} is not in the store — checked local .memory/records/ and {ref}. Ship it on the lane first, then correct it; no record was written.",
  'memory.plainfiles.save.supersedesUnverifiable': "--supersedes {id} could not be verified: {reason}. Fix it with `git fetch origin main`, or point BRAIN_MEMORY_UPSTREAM_REF / memory.upstreamRef at a ref that resolves; no record was written.",
  'memory.plainfiles.save.supersedesConfigError': 'brain.config.json could not be read while checking --supersedes: {error}. The check still ran against whatever ref resolved without it.',
  'memory.save.supersedesRepeated': '--supersedes accepts exactly one id per save — fan-in (multiple records superseding the same id) is deferred (#805). Refused before any write.',
  'memory.save.supersedesMissingValue': '--supersedes requires a value (the id it supersedes) — refused before any write, so the record is never saved silently without the field you asked for.',
  // ── #874 — hydrate({recordId}): the record is already durable before this runs, so a
  // backend failure here is reported, never thrown (R5) ──
  'memory.save.hydrateDeferred': 'record {recordId} is on disk, but hydrating it into engram was deferred — {reason}. The record is NOT lost; re-run `npm run brain:memory:pull` (or `brain:memory:share`) once engram is reachable to catch it up.',
  'memory.save.hydrateContended': 'record {recordId} is on disk, but hydrating it into engram was skipped — another process (pid {pid}, {age}s) holds the #820 hydration guard. The record is NOT lost; it will be picked up on the next pull/share.',
  'memory.hydrate.recordNotFound': "hydrate: no record with id '{recordId}' found under .memory/records/ — pass the record itself when hydrating one that has not been read back from disk yet.",
  'memory.plainfiles.search.empty': 'ℹ no matching records found.',
  'memory.plainfiles.search.summary': '{count} matching record(s):',

  // ── brain-protect.mjs — arm-and-verify (issue #203) ───────────────────────────
  'protect.verify.unverifiable': '  Verify   : no check-runs found yet on {branch} — unverifiable until the first PR runs.',
  'protect.verify.missing':      '  WARNING  : required check "{context}" has no matching check-run yet — confirm the job name is exact.',
  'protect.verify.unsupported':  '  Verify   : run verification not supported on provider {provider} — armed contexts not cross-checked.',
};
