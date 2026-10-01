// brain/scripts/i18n/es.mjs — Partial Spanish catalog.
//
// Only keys that differ from English need to be listed here.
// Any key absent from this file falls back to en.mjs per-key — no whole-file
// replacement. Set docs.language: es in brain.config.json to activate.
//
// Grows as scripts are migrated in PR2 and PR3.
// Templates use the same named {placeholder} slots as en.mjs.
export default {
  // ── Seed keys (PR1) ──────────────────────────────────────────────────────────
  'day.auth.ok':         'Autenticado como @{user} ({provider}).',
  'tracker.yourTickets': 'Tus tickets',
  'common.none':         '(ninguno)',

  // ── Shared ───────────────────────────────────────────────────────────────────
  'common.signal': 'señal',

  // ── day-start.mjs (PR2) ──────────────────────────────────────────────────────
  'day.run.exitCode': '↳ salió con código {code} (no bloqueante).',

  'day.vcs.section':       'Autenticación del VCS',
  'day.main.section':      'Sincronización de main',
  'day.ecosystem.section': 'Actualizaciones del ecosistema',
  'day.brain.section':     'Versión de brain (core)',
  'day.memory.section':    'Memoria de equipo',
  'day.board.section':     'Tablero de tickets',

  'day.vcs.notConfigured':  'Provider de VCS no configurado — seteá vcs.provider en brain.config.json.',
  'day.vcs.authOk':         'Autenticado ({provider}).',
  'day.vcs.sessionExpired': 'Sesión no iniciada o vencida — reautenticando desde .env...',
  'day.vcs.tokenNotFound':  'Token no encontrado en .env — corré brain:env:init',
  'day.vcs.authFailed':     'Auth falló — verificá el token o que el CLI del provider esté instalado. brain:env:init',

  'day.main.noVcs':         'No se puede sincronizar main — provider de VCS o token no disponible.',
  'day.main.fetchFailed':   'Fetch de main falló — verificá conectividad a {host}',
  'day.main.updated':       'main actualizado (fast-forward aplicado).',
  'day.main.pullFailed':    'No se pudo aplicar pull a main — puede haber cambios locales sin commitear.',
  'day.main.remoteUpdated': 'main remoto actualizado (rama activa: {branch}).',
  'day.main.newCommits':    '{count} commit(s) nuevos en main:',
  'day.main.upToDate':      'main ya estaba al día.',

  'day.ecosystem.notAvailable':    'gentle-ai no disponible — skipping actualizaciones.',
  'day.ecosystem.install':         'Instalar: npm run tools:install',
  'day.ecosystem.checking':        'Verificando versiones...',
  'day.ecosystem.allUpToDate':     'Todas las herramientas al día.',
  'day.ecosystem.updatesAvailable':'{count} actualización(es) disponible(s):',
  'day.ecosystem.applying':        'Aplicando actualizaciones...',
  'day.ecosystem.done':            'Listo.',
  'day.ecosystem.skillRegistry':   'Skill registry actualizado.',

  'day.brain.unknownInstalled': 'No se pudo determinar la versión instalada de brain — skipping check.',
  'day.brain.registryUnreachable': 'No se pudo alcanzar el registry para consultar {pkg} — el chequeo se SALTEÓ, no pasó.',
  'day.brain.notPublished':     '{pkg} todavía no tiene ninguna versión publicada.',
  'day.brain.newVersion':       'Hay una versión nueva de brain: {installed} → {latest}',
  'day.brain.upgrade':          'Actualizá a conciencia: {pm} run brain:upgrade -- {latest}',
  'day.brain.noAutoApply':      '(no se auto-aplica — revisá el changelog del tag antes)',
  'day.brain.upToDate':         'brain al día ({installed}).',

  'day.memory.hookMissing':    'Hook pre-push ausente en {path}/pre-push — el checkpoint de la memoria de feature no corre en el push.',
  'day.memory.hookActivated':  'Pre-push hook activado (core.hooksPath={hooksPath}).',
  'day.memory.hookFailed':     'No se pudo activar el pre-push hook (core.hooksPath).',
  'day.memory.hookActive':     'Pre-push hook activo — checkpointea la memoria de feature antes del push.',
  'day.memory.importing':      'Importando chunks de .memory/ al DB local...',
  'day.memory.reprojecting':   'Reproyectando brain/ a engram...',
  'day.memory.exporting':      'Exportando memoria al repo (.memory/)...',
  'day.memory.exported':       'Memoria exportada a .memory/ — lista para commitear con el próximo push.',
  'day.memory.exportFailed':   'Export de engram falló — corré {pm} run brain:memory:share manualmente.',
  'day.memory.notAvailable':   'engram no disponible — skipping memoria compartida.',
  'day.memory.install':        'Instalar: gentle-ai install   o   npm run tools:install',

  // Lane sweep (#906, design.md A7) — una línea, sólo cuando memory.lane.enabled es true.
  'day.memory.laneSweep.running':        'Chequeando el lane sweep...',
  'day.memory.laneSweep.shipped':        'Lane sweep: se envió {ref} (PR #{number}).',
  'day.memory.laneSweep.reconciled':     'Lane sweep: se reconcilió {ref} (PR #{number}) — nada nuevo para enviar.',
  'day.memory.laneSweep.nothing':        'Lane sweep: nada para enviar.',
  // F2 (cold review, #921/#923): nada pendiente, pero un worktree no se pudo
  // inspeccionar — distinto de la línea "nada para enviar" de arriba.
  'day.memory.laneSweep.worktreeSkipped': 'Lane sweep: nada para enviar, pero {count} worktree(s) no se pudieron inspeccionar: {paths}',
  'day.memory.laneSweep.warn':           'Lane sweep: {detail} — ver el log en tmp; el sweep de mañana reintenta.',
  // El texto propio de {detail} — una key, no un literal, para que un
  // docs.language no inglés nunca vea una palabra en inglés dentro de una
  // línea traducida (#906 cold review, editorial).
  'day.memory.laneSweep.detailUnparsed':  'salida de ship no parseable',
  'day.memory.laneSweep.detailExitCode':  'ship terminó con código {status}',

  // Lane sweep entre días, por rama (#936, tabla de sweep de design.md) —
  // una línea por fila de `outcome.sweep.branches[]`, renderizada por
  // `laneSweepBranchLines()`. `deleted`/`shipped`/`reconciled` son de
  // rutina (`ok`); el resto necesita la atención de una persona (`warn`).
  'day.memory.laneSweep.branch.deleted':        'Lane sweep: {branch} ({date}) ya se había entregado por completo — se borró la rama local.',
  'day.memory.laneSweep.branch.shipped':        'Lane sweep: {branch} ({date}) se volvió a enviar — pull request #{number}.',
  'day.memory.laneSweep.branch.reconciled':     'Lane sweep: {branch} ({date}) se reconcilió — pull request #{number}, nada nuevo para enviar.',
  'day.memory.laneSweep.branch.closedUnmerged': '⚠ Lane sweep: {branch} ({date}) no se volvió a enviar — el pull request #{number} se cerró sin fusionarse; borrá la rama local para dejar de ver este aviso.',
  'day.memory.laneSweep.branch.unknown':        '⚠ Lane sweep: {branch} ({date}) tiene un estado ilegible — se mantiene, no se adivina.',
  'day.memory.laneSweep.branch.diverged':       '⚠ Lane sweep: {branch} ({date}) divergió de su remoto — no se forzó nada.',
  'day.memory.laneSweep.branch.failed':         '⚠ Lane sweep: {branch} ({date}) no se pudo reconciliar — {reason}',
  'day.memory.laneSweep.branch.remoteOnly':     '⚠ Lane sweep: {branch} ({date}) sólo existe en el remoto — se reporta, no se modifica.',
  // #936 remediation: el sweep completo puede fallar de forma cerrada
  // (cli.mjs aísla un throw del código previo al loop de sweepLanes()) —
  // distinto de una fila por rama y de `day.memory.laneSweep.warn`.
  'day.memory.laneSweep.sweepFailed': '⚠ El lane sweep falló — {reason}; no se cambió ni reconcilió nada esta vez.',

  'day.done.withTicket':      'Con ticket:',
  'day.done.ticketStart':     'brain:ticket:start -- <iid>   (terminal)',
  'day.done.ticketStartAgent':'/ticket-start <iid>             (Claude / agente IA)',
  'day.done.noTicket':        'Sin ticket — explorá o proponé:',
  'day.done.sddExplore':      '/sdd-explore <idea>             investigar antes de comprometerse',
  'day.done.gitlabIssue':     '/gitlab-issue                   crear un issue desde una idea',
  'day.done.beforePush':      'Antes de pushear:',
  'day.done.checkCmd':        '{pm} run brain:repo:check; capturá memoria durable con {pm} run brain:memory:save --issue <id> (el memory lane habilitado la envía)',

  // ── tracker-board.mjs (PR2) ───────────────────────────────────────────────────
  'tracker.noRemote':        '⚠ No se pudo detectar el remote de origin.',
  'tracker.vcsNotConfigured':'⚠ Provider de VCS no configurado: {error}',
  'tracker.noSession':       '⚠ Sin sesión de VCS autenticada para {host} — mirá https://{host}/{project}',
  'tracker.noUser':          '⚠ No se pudo obtener el usuario — solo se muestran tickets sin asignar.',
  'tracker.unassigned':      'Sin asignar',

  // ── project-status.mjs (PR2) ──────────────────────────────────────────────────
  'ps.title':             '# Estado del monorepo — proyección generada, NO editar ni guardar',
  'ps.maven.section':     '## Reactor Maven',
  'ps.maven.count':       '{count} módulo(s) en el reactor (incluye agregadores).',
  'ps.maven.orphansTitle':'⚠ Poms trackeados FUERA del reactor (no se construyen con backend:build):',
  'ps.maven.missingPom':  '(pom AUSENTE: {dir})',
  'ps.frontend.section':  '## Frontend (Nx)',
  'ps.frontend.empty':    'Sin proyectos Nx aún (frontend vacío).',
  'ps.frontend.count':    '{count} proyecto(s) Nx.',
  'ps.vcs.section':       '## Trabajo abierto',
  'ps.vcs.noRemote':      '⚠ No se pudo detectar el remote de origin.',
  'ps.vcs.notConfigured': '⚠ Provider de VCS no configurado (vcs.provider en brain.config.json).',
  'ps.vcs.noSession':     '⚠ Sin sesión de VCS autenticada — mirá https://{host}/{repo}',
  'ps.vcs.issues':        'Issues abiertos ({count}):',
  'ps.vcs.prs':           'PRs/MRs abiertos ({count}):',
  'ps.vcs.error':         '⚠ No se pudo consultar el VCS: {message}',
  'ps.footer':            '— Fin de la proyección. Para regenerar: brain:project:status',

  // ── verify-change.mjs ────────────────────────────────────────────────────────
  'verify.error.rerun':   'Corregí y volvé a correr: {pm} run brain:change:verify',

  // ── brain-upgrade.mjs ────────────────────────────────────────────────────────
  'upgrade.error.usage':  'Uso: {pm} run brain:upgrade -- v0.1.0 [--dry-run] [--no-install] [--force]',

  // ── bootstrap.sh (PR3) ───────────────────────────────────────────────────────
  // §1 Base dependencies
  'bootstrap.deps.section': 'Dependencias base',
  'bootstrap.deps.missing': "Falta '{tool}' (requerido). Instalalo y volvé a correr brain:env:init.",
  'bootstrap.deps.ok':      'git, python3 presentes; gestor de paquetes: {pm}',

  // §2 Ecosystem tools
  'bootstrap.ecosystem.section':  'Herramientas del ecosistema',
  'bootstrap.ecosystem.notFound': '{tool} no encontrado — {hint}',

  'bootstrap.gitignore.ok':     '.env está en gitignore',
  'bootstrap.gitignore.failed': 'no se pudo confirmar que .env esté en gitignore — revisá .gitignore a mano antes de commitear',

  // §3 Personal access token
  'bootstrap.pat.section':         'Token personal de acceso (.env)',
  'bootstrap.pat.alreadySet':      '{var} ya configurado en .env',
  'bootstrap.pat.noTty':           'sin TTY: agregá {var} a .env y volvé a correr brain:env:init',
  'bootstrap.pat.openPrompt':      '¿Abro el navegador con el formulario pre-llenado? [S/n]: ',
  'bootstrap.pat.manualUrl':       'Crealo a mano en: {url}',
  'bootstrap.pat.browserFallback': 'Si el navegador no se abrió, entrá a: {url}',
  'bootstrap.pat.enterPrompt':     'Pegá tu PAT (no se muestra): ',
  'bootstrap.pat.skipped':         'Sin token: se salta la autenticación del VCS. Volvé a correr brain:env:init cuando lo tengas.',
  'bootstrap.pat.saved':           '{var} guardado en .env (gitignored)',
  'bootstrap.pat.trackedRefused':     '{var} NO se escribió — .env ya está trackeado por git, así que ningún patrón de .gitignore puede protegerlo. Destrackealo primero: git rm --cached .env — y volvé a correr brain:env:init.',
  'bootstrap.pat.gitignoreRefused':   '{var} NO se escribió — no se pudo confirmar que .env esté en gitignore. Arreglá .gitignore a mano y volvé a correr brain:env:init.',
  'bootstrap.pat.symlinkRefused':          '{var} NO se escribió — .env es un symlink a {target}; tiene que ser un archivo regular, o el token se escribiría fuera de este repo. Reemplazalo por un archivo regular y volvé a correr brain:env:init.',
  'bootstrap.pat.notRegularFileRefused':   '{var} NO se escribió — .env existe pero no es un archivo regular. Tiene que ser un archivo regular; volvé a correr brain:env:init.',
  'bootstrap.pat.hardlinkedRefused':        '{var} NO se escribió — .env es un hardlink a otro archivo, así que el token también quedaría ahí. Reemplazalo por un archivo regular independiente y volvé a correr brain:env:init.',
  'bootstrap.pat.settingsNote':             'Los ajustes no secretos (MEMORY_BACKEND, AGENT_PLATFORM, SDD_ENGINE) igual se escriben en .env.',

  // §4 Git credential helper
  'bootstrap.cred.section': 'Credential helper de git (HTTPS)',
  'bootstrap.cred.ok':      'push/pull por HTTPS usan tu PAT personal de .env',

  // §5 VCS authentication
  'bootstrap.auth.section':   'Autenticación del VCS',
  'bootstrap.auth.alreadyOk': 'ya autenticado contra {host}',
  'bootstrap.auth.ok':        'autenticado contra {host}',
  'bootstrap.auth.failed':    'auth falló — verificá el token en .env',
  'bootstrap.auth.noToken':   'Sin token: VCS queda sin autenticar',

  // §6 SDD harness
  'bootstrap.sdd.section':            'Implementación SDD (harness)',
  'bootstrap.sdd.prompt':             '¿Qué implementación SDD usás? [gentle-ai]: ',
  'bootstrap.sdd.ok':                 'harness: {harness} (.env)',
  'bootstrap.sdd.gentleaiMissing':    'gentle-ai ausente — brew install gentle-ai y volvé a correr brain:env:init',
  'bootstrap.sdd.ecosystemOk':        'ecosistema ya inicializado (gentle-ai doctor)',
  'bootstrap.sdd.ecosystemConfigured':'ecosistema configurado (skills, engram, gga)',
  'bootstrap.sdd.ecosystemFailed':    'gentle-ai install falló — corrélo a mano y volvé a correr brain:env:init',
  'bootstrap.sdd.noTty':              "sin TTY: corré 'gentle-ai install' manualmente",
  'bootstrap.sdd.registryOk':         'skill registry actualizado',
  'bootstrap.sdd.registryFailed':     'skill-registry refresh falló (no bloqueante)',
  'bootstrap.sdd.unknownHarness':     "harness '{harness}' sin rutina de init conocida — configurá sus skills a mano",
  'bootstrap.sdd.initFailed':         'init del harness falló — REQUERIDO, env:init saldrá con 1',
  // ADR gap detection (Step 4 of gentle-ai init)
  'bootstrap.sdd.noProjectAdrs':      'No se encontraron ADRs del proyecto (brain/project/decisions/ está vacío o ausente).',
  'bootstrap.sdd.noProjectAdrsHint':  'Ejecutá /project:bootstrap-adrs en tu agente de IA para generar el conjunto inicial de ADRs (Stack, Testing, Build).',

  // §7 Team memory
  'bootstrap.memory.section':        'Memoria de equipo',
  'bootstrap.memory.prompt':         '¿Qué backend de memoria usa este equipo? (engram|plainfiles): ',
  'bootstrap.memory.undeclared':     'no hay backend de memoria declarado (env, .env, brain.config.json memory.backend) — no se adivinó ninguno, así que se saltó el setup de memoria. Siguiente: npm run brain:config -- set memory.backend engram|plainfiles, y volvé a correr env:init.',
  'bootstrap.memory.invalid':        "el backend de memoria '{value}' (de {source}) no es 'engram' ni 'plainfiles' — se saltó el setup de memoria. Corregilo donde está seteado y volvé a correr env:init.",
  'bootstrap.memory.unreadable':     "no se pudo leer brain.config.json, así que no se resolvió el backend de memoria — {detail}. No se preguntó ni se escribió nada; corregí o restaurá el archivo y volvé a correr env:init.",
  'bootstrap.memory.resolverFailed': "el resolvedor del backend de memoria falló (exit {code}) — es la verificación fallando, no un backend sin declarar. No se preguntó ni se escribió nada.",
  'bootstrap.memory.declared':       'backend de memoria guardado en brain.config.json (memory.backend) — commitealo para que todos los checkouts usen el mismo backend',
  'bootstrap.memory.declareFailed':  'no se pudo escribir memory.backend en brain.config.json — seteálo con: npm run brain:config -- set memory.backend {backend}',
  'bootstrap.memory.envOnly':        'el backend de memoria {backend} viene solo del .env de esta máquina — tus compañeros y los clones nuevos no lo ven. Para compartirlo con el equipo: npm run brain:config -- set memory.backend {backend}',
  'bootstrap.memory.envShadows':     'el valor de {source} ({backend}) pisa a brain.config.json memory.backend ({configured}) en esta máquina',
  'bootstrap.memory.backend':        'backend de memoria: {backend} ({source})',
  'bootstrap.memory.hookOk':         'pre-push hook activado (checkpointea la memoria de feature antes del push — ADR-0003)',
  'bootstrap.memory.hookFailed':     'no se pudo activar core.hooksPath (pre-push hook)',
  'bootstrap.memory.nodeAbsent':     'node ausente — setup del backend engram salteado',
  'bootstrap.memory.engram.ok':      'backend engram configurado (symlink + merge driver)',
  'bootstrap.memory.engram.failed':  'memory setup falló — REQUERIDO, env:init saldrá con 1',
  'bootstrap.memory.pull.ok':        'memoria importada (.memory/ → engram)',
  'bootstrap.memory.pull.failed':    'brain:memory:pull falló — REQUERIDO, env:init saldrá con 1',
  'bootstrap.memory.pull.skipped':   'pull de memoria omitido — {reason}. Siguiente: npm run brain:memory:pull cuando eso esté listo.',
  'bootstrap.memory.pull.noCommits': 'este repositorio todavía no tiene commits',
  'bootstrap.memory.pull.noUpstream': 'esta rama no tiene upstream del cual hacer pull',
  'bootstrap.memory.pull.offline':   'no se pudo alcanzar el remoto',
  'bootstrap.memory.engramAbsent':   'engram no está instalado — se omiten hidratación e indexado (la captura solo con registros sigue funcionando). Siguiente: instalá engram y corré npm run brain:memory:pull && npm run brain:memory:index.',
  'bootstrap.memory.index.ok':       'índice durable reproyectado (brain/ → engram)',
  'bootstrap.memory.index.failed':   'brain:memory:index falló — REQUERIDO, env:init saldrá con 1',
  'bootstrap.memory.plainfiles.ok':      'backend plainfiles listo (.memory/records/ + index)',
  'bootstrap.memory.plainfiles.failed':  'setup de memoria plainfiles falló — REQUERIDO, env:init saldrá con 1',
  'bootstrap.memory.plainfiles.noIndex': 'la indexación brain/ → memoria es exclusiva de engram; plainfiles no proyecta docs por diseño',
  'bootstrap.memory.unknownBackend': "backend '{backend}' sin rutina de init conocida — configuralo a mano",

  // §8 Ticket board
  'bootstrap.board.section': 'Tickets abiertos en {path}',
  'bootstrap.board.failed':  'no se pudo listar tickets — mirá https://{host}/{path}',

  // §9 Done
  'bootstrap.done.section': 'Entorno listo',
  'bootstrap.done.pending': 'Pendiente: {tools}',
  'bootstrap.done.install': 'Corré: npm run tools:install  (instala todo de una)',
  'bootstrap.done.requiredFailed': '✗ Paso(s) requerido(s) fallaron: {items} — env:init NO se completó con éxito.',

  // ── lib/tier-notice.mjs (#1124) ───────────────────────────────────────────────
  'config.tier.new':       'nivel de gobernanza: {tier} — establecido para este repositorio nuevo (governance.tier en brain.config.json).',
  'config.tier.declared':  'nivel de gobernanza: {tier} — ya declarado en brain.config.json; sin cambios.',
  'config.tier.absent':    'nivel de gobernanza: standard — brain.config.json no declara ninguno, y un nivel ausente se resuelve como standard; sin cambios.',
  'config.tier.invalid':   'governance.tier "{tier}" en brain.config.json no es un nivel ({tiers}) — toda compuerta que lo lee falla cerrada hasta que se corrija.',
  'config.tier.why.lite':  'lite es para un solo mantenedor: no se requiere una segunda aprobación para fusionar, y todas las compuertas siguen corriendo.',
  'config.tier.why.standard':  'standard es para un equipo: una fusión necesita una segunda aprobación, de alguien que no sea el autor.',
  'config.tier.why.regulated': 'regulated es para trabajo auditado: la evidencia más estricta, y sin excepciones.',
  'config.tier.change':    'Para cambiarlo, establecer governance.tier en brain.config.json a lite, standard (un equipo: una segunda aprobación de alguien que no sea el autor) o regulated (auditado: la evidencia más estricta, sin excepciones) — p. ej. npm run brain:config -- set governance.tier standard — y luego volver a ejecutar npm run brain:protect.',
  'config.lane.on':        'carril de memoria: activo — los registros de memoria llegan a main en su propio pull request (memory.lane.enabled en brain.config.json).',
  'config.lane.off':       'carril de memoria: apagado — los registros de memoria quedan en tu clon; nada los lleva a main por vos.',
  'config.lane.why':       'El carril está apagado por defecto en todos los tiers porque abre un pull request aparte para los registros de memoria que un mantenedor tiene que mergear; encenderlo es una decisión deliberada.',
  'config.lane.enable':    'Para encenderlo: npm run brain:config -- set memory.lane.enabled true',

  // ── install-tools.sh (PR3) ────────────────────────────────────────────────────
  'tools.require.noApt': 'Este script requiere apt-get (Ubuntu/Debian). Instalá las herramientas manualmente según brain/project/methodology/developer-environment.md.',
  'tools.installed': 'ya instalado',

  'tools.apt.section':    'Paquetes del sistema (apt)',
  'tools.apt.installing': 'Instalando: {pkgs}',
  'tools.apt.ok':         'apt: {pkgs}',
  'tools.apt.allPresent': 'todos los paquetes apt ya presentes',

  'tools.vcs.section':   'CLI del VCS ({cli})',
  'tools.vcs.installed': '{cli} instalado',
  'tools.vcs.notInApt':  '{cli} no está en apt — instalalo a mano:',

  'tools.node.installing': 'Instalando nvm...',
  'tools.node.nvmOk':      'nvm instalado',
  'tools.node.nodeOk':     'node {version} via nvm',
  'tools.node.reloadShell':'Abrí una terminal nueva o ejecutá: source ~/.bashrc',

  'tools.claude.section':   'Claude Code (CLI de Anthropic)',
  'tools.claude.installed': 'claude instalado',

  'tools.gentleai.section':          'gentle-ai + ecosistema (engram, gga)',
  'tools.gentleai.installing':       'Instalando gentle-ai...',
  'tools.gentleai.ok':               'gentle-ai instalado',
  'tools.gentleai.alreadyConfigured':'ecosistema gentle-ai ya configurado',
  'tools.gentleai.configuring':      'Configurando ecosistema (engram, gga, skills)...',
  'tools.gentleai.configured':       'ecosistema configurado',
  'tools.gentleai.configFailed':     'gentle-ai install falló — reintentá a mano',

  'tools.summary.incomplete':    'Instalación INCOMPLETA — pasos fallidos: {steps}. Corregí los errores de arriba y volvé a correr.',
  'tools.summary.section':       'Instalación completa',
  'tools.summary.nextStep':      'Siguiente paso:',
  'tools.summary.checkVersions': 'Verifica versiones:',
  'tools.summary.notFound':      '{tool}  (no encontrado — reiniciá la terminal)',

  // ── ticket-start.mjs (PR2) ────────────────────────────────────────────────────
  'ticket.error.baseRequiresArg': '✗ --base requiere un nombre de rama. Ej: --base feature/issue-99-mi-historia',
  'ticket.error.usage':           'Uso: brain:ticket:start -- <issue-id> [--worktree] [--base <rama>] [--off-tracker]',
  'ticket.error.usageExample1':   'Ejemplo: brain:ticket:start -- 42',
  'ticket.error.usageExample2':   '         brain:ticket:start -- 42 --worktree --base feature/issue-99-mi-historia',
  'ticket.error.noRemote':        '✗ No se pudo detectar el remote de origin.',
  'ticket.error.vcsInit':         '✗ No se pudo inicializar el VCS: {message}',
  'ticket.error.tokenNotFound':   '✗ Token del VCS no encontrado en .env — corré brain:env:init',
  'ticket.fetching':              'Buscando issue #{id}...',
  'ticket.error.fetchFailed':     '✗ No se pudo obtener el issue #{id} — verificá la sesión del VCS y el id. {message}',
  'ticket.error.notFound':        '✗ Issue #{id} no encontrado en {project}',
  'ticket.labels':                'Labels: {labels}',
  'ticket.branch':                'Rama: {branch}',
  'ticket.updatingBase':          'Trayendo origin/{base} (la rama desde la que arranca esta tarea)...',
  'ticket.staleCheckout':          '⚠ Este checkout está ATRÁS de origin/{branch} ({head} → {base}), y brain/scripts/ difiere.',
  'ticket.staleCheckoutHint':      '    Puede que estés corriendo una versión vieja de este verbo. Para actualizar: git -C {root} merge --ff-only origin/{branch}',
  'ticket.error.fetchBase':       '✗ No se pudo fetchear la rama base \'{branch}\' del remoto.',
  'ticket.error.fetchBaseHint':   '    ¿Existe y está pusheada? Verificá el nombre.',
  'ticket.error.worktreeExists':  '✗ Ya existe la carpeta del worktree: {path}',
  'ticket.error.worktreeExistsHint': '    Eliminala (git worktree remove) o usá otro issue.',
  'ticket.error.worktreeCreate':  '✗ Error al crear el worktree: {error}',
  'ticket.worktreeCreated':       '✓ Worktree creado en {path}',
  'ticket.envCopied':             '✓ .env copiado al worktree.',
  'ticket.noEnv':                 '→ No hay .env en {root} — saltando copia.',
  'ticket.branchExists':          '→ Rama ya existe — cambiando a ella...',
  'ticket.error.branchCreate':    '✗ Error al crear la rama: {error}',
  'ticket.branchCreated':         '✓ Rama creada y activa.',
  'ticket.mode.worktree':         'Worktree aislado (el default — harness-contract.md lo exige para trabajo en paralelo).',
  'ticket.mode.inPlace':          'Rama IN-PLACE en el checkout principal — sólo válido para trabajo estrictamente individual y serial. Ningún otro agente puede trabajar en paralelo mientras esta rama esté acá.',
  'ticket.error.contradictoryModes': 'se pasaron --worktree y --in-place a la vez. Se rechaza en vez de elegir uno: pedí un solo modo.',

  // ── ticket-start.mjs — la base sale de la épica (#967) ──────────────────────
  // Todas dicen el motivo. Una base que nadie eligió y nadie puede explicar es
  // la forma silenciosa en que una slice termina en la rama equivocada.
  'ticket.base.fromEpic':         '→ Base: {tracker} — declarada por la épica #{epic} (parent leído del {source}).',
  'ticket.base.noEpic':           '→ Base: {base} — no aplica ningún tracker de épica (motivo: {reason}).',
  'ticket.base.epicUnreadable':   '→ Base: {base} — no se pudo leer la épica #{epic}, se continúa igual: {message}',
  'ticket.base.offTracker':       '→ Base: {base} — FUERA DEL TRACKER: la épica #{epic} declara {tracker}, y se pasó --off-tracker.',
  'ticket.error.baseIsTracked':   '✗ se pasó --base {base}, pero la épica #{epic} declara el tracker {tracker} — mientras esa épica está en vuelo una slice arranca de ahí. Usá --base {tracker}, o pasá {flag} para declarar que esta rama deliberadamente no lo hace.',

  'ticket.error.noTypeLabel':     '✗ El issue #{id} no tiene una etiqueta type:* (etiquetas encontradas: [{labels}]) — brain:ship lo rechazaría más adelante. Agregá una ahora en el issue (por ejemplo type:feature, type:bug o type:chore; type::feature en GitLab) y volvé a ejecutar.',

  'ticket.nextSteps.header':      'Próximos pasos:',
  'ticket.nextSteps.cd':          '    0. cd {path}   (abrí tu sesión de trabajo acá)',
  'ticket.nextSteps.step1':       '    1. Implementar — usá /sdd-new {id} si el cambio es complejo',
  'ticket.nextSteps.step2':       '    2. {pm} run brain:repo:check antes de cada commit',
  'ticket.nextSteps.step3':       '    3. Capturá memoria durable con {pm} run brain:memory:save --issue {id}; el memory lane habilitado la envía antes de pushear',
  'ticket.nextSteps.step4':       '    4. git push -u origin {branch}',

  // ── ticket-start.mjs — feature working memory (Slice 3) ─────────────────────
  'ticket.resume.noContext': '→ No se encontró contexto de reanudación — continuando.',

  // ── session-start.mjs (issue #138, PR3) ───────────────────────────────────────
  'session.header':             'brain · contexto de sesión',
  'session.branch':             'rama:      {branch}',
  'session.branch.unknown':     '(desconocida)',
  'session.change.one':         'cambio:    {change}',
  'session.change.none':        'cambio:    (sin carpeta de cambio para la rama)',
  'session.change.ambiguous':   'cambio:    ambiguo ({count}): {list}',
  'session.memory.ok':          'memoria:   engram hidratado',
  'session.memory.skip':        'memoria:   engram no disponible (omitido)',
  'session.memory.notDeclared': "memoria:   hidratación omitida, no se intentó nada — {reason}",
  'session.memory.skip.reason': 'memoria:   engram no disponible (omitido) — {reason}',
  'session.memory.recency.stale':   'memoria:  el registro durable más nuevo tiene {days} días — nada capturado desde entonces (ver #519)',
  'session.memory.recency.unknown': 'memoria:  sin registro durable — no se puede determinar cuándo se capturó memoria por última vez',
  'session.ticket.label':       'ticket:',
  'session.ticket.none':        '(sin memoria de ticket activa)',

  // ── memory/cli.mjs — reindex (issue #205, C1) ─────────────────────────────────
  'memory.audit.failed':   '✗ audit no pudo correr — {message}',
  'memory.audit.badSince': '✗ audit: --since no es una fecha — {value}',
  'memory.reindex.done':   '✓ reindex completo — {count} registro(s) indexado(s).',
  'memory.reindex.failed': '✗ reindex falló — {message}',
  'memory.resolveIndex.done':   '✓ índice regenerado desde records/ — {count} registro(s). No había nada en conflicto, no se agregó nada al stage.',
  'memory.resolveIndex.staged': '✓ conflicto del índice resuelto — {count} registro(s) regenerados desde records/ y agregados al stage. Completá el merge con `git commit`.',
  'memory.resolveIndex.failed': '✗ resolve-index falló — {message}',

  // ── memory/lib/duplicates.mjs — formatDuplicateReport() (issue #574, promovido #638) ──
  'memory.duplicates.summary': '⚠ {ids} id(s) de registro duplicado(s) en .memory/records/ — {lines} línea(s) física(s) excedente(s) colapsada(s) en {surface}.',
  'memory.duplicates.summaryWithIndex': '⚠ {ids} id(s) de registro duplicado(s) en .memory/records/ — {lines} línea(s) física(s) excedente(s) colapsada(s) en {surface} ({total} línea(s) física(s) → {indexCount} indexada(s)).',
  'memory.duplicates.why': '  Deduplicado, no rechazado: `merge=union` concatena ambas copias cuando dos ramas tienen el mismo registro (ADR-0017, REQ-MF-3), así que esto es el transporte funcionando, no un store corrupto — pero `wc -l .memory/records/*.jsonl` sobreestima el store por {lines}, y solo se reporta porque estás leyendo esto.',
  'memory.duplicates.divergent': '  {count} de ellos DISCREPAN fuera de los campos hasheados (`source` no está hasheado, así que dos copias de un mismo registro pueden diferir ahí — el propio export→import→export de brain lo ensancha). Resuelto first-wins: la línea más antigua del archivo mensual más antiguo es la que queda indexada, tal como resuelve el camino de lectura. Marcado [divergent] abajo — vale la pena mirarlo, no es un error.',
  'memory.duplicates.brief': '  Corré `npm run brain:memory:reindex` para ver las ubicaciones por id.',
  'memory.duplicates.group': '  {id} ×{count} — {locations}',
  'memory.duplicates.groupDivergent': '  {id} ×{count} [divergent] — {locations}',
  'memory.duplicates.moreOccurrences': ', +{count} más',
  'memory.duplicates.moreGroups': '  … +{count} id(s) duplicado(s) más.',
  'memory.duplicates.unknownId': '(id desconocido)',

  // ── memory/cli.mjs — split-records (issue #677) ──────────────────────────────
  'memory.splitRecords.plan':    'plan — {lines} línea(s) de registro en {months} archivo(s) mensual(es) pasan a ser {writes} archivo(s) por registro. NO se escribió nada. Volvé a correrlo con --apply para ejecutarlo.',
  'memory.splitRecords.done':    '✓ split completo — {written} archivo(s) de registro escritos, {alreadyPresent} ya presentes, {months} archivo(s) mensual(es) borrados después de verificar que cada registro se relee.',
  'memory.splitRecords.nothing': 'nada que dividir — no hay archivo mensual <yyyy-mm>.jsonl en .memory/records/ ({alreadySplit} archivo(s) por registro ya presentes).',
  'memory.splitRecords.repeats': '{count} línea(s) repetida(s) colapsadas gana-la-primera ({divergent} divergentes — mismo id, bytes distintos). La ganadora es la línea que los lectores ya resolvían.',
  'memory.splitRecords.failed':  '✗ split-records falló — {message}',

  // ── memory/cli.mjs — heal-duplicates (#1061, #864 tarea 1.2a) ────────────────
  'memory.heal.none':               'nada que sanar — {rows} fila(s) rec- viva(s), {distinct} clave(s) distinta(s).',
  'memory.heal.plan':               'plan — se encontraron {count} clave(s) duplicada(s). NO se borró nada. Volvé a correrlo con --apply para ejecutarlo.',
  'memory.heal.deleted':            '✓ se borraron {count} fila(s): {ids}.',
  'memory.heal.done':               '✓ sanación verificada — {rows} fila(s) rec- viva(s), {distinct} clave(s) distinta(s).',
  'memory.heal.partial':            '✗ la sanación se detuvo tras un borrado fallido — borradas {deleted}, sin borrar {notDeleted} ({detail}). No se tocó nada más; volvé a correrlo una vez resuelta la causa.',
  'memory.heal.unverified':         '✗ no se pudo verificar la sanación — se borraron {deleted} fila(s) pero un export nuevo todavía muestra un duplicado. No se borró nada más.',
  'memory.heal.notEngram':          "heal-duplicates solo aplica al backend 'engram', no a '{backend}'. No se borró nada.",
  'memory.heal.badFlag':            "flag desconocida '{flag}'. Solo se acepta --apply. No se borró nada.",
  'memory.heal.failed':             '✗ heal-duplicates falló — {message}',
  'memory.heal.refused.divergent':  "rechazado — '{key}' tiene copias que difieren en {fields}. No se borró nada.",
  'memory.heal.refused.tooMany':    "rechazado — '{key}' tiene {count} fila(s) viva(s), más de las dos que esta sanación entiende. No se borró nada.",
  'memory.heal.refused.shape':      'rechazado — el export no tiene una forma que esta sanación entienda ({detail}). No se borró nada.',
  'memory.heal.refused.version':    'rechazado — {detail}. No se borró nada.',

  // ── memory/cli.mjs — collect (issue #887, ADR-0034 L4/C2) ────────────────────
  'memory.collect.done':    '✓ se juntaron {collected} registro(s) en {ref} ({commit}).',
  'memory.collect.nothing': 'nada nuevo para juntar — {ref} sin cambios.',
  'memory.collect.offline': 'no se pudo hacer fetch de origin/main; se siguió con el origin/main local.',
  'memory.collect.failed':  '✗ collect falló — {message}',
  'memory.collect.badHost': '✗ collect falló — el nombre de host produjo un slug de ref vacío o inválido: {message}',
  'memory.collect.raced':   '✗ collect falló — la ref del lane se movió durante esta corrida (raced); no se perdió nada, sus blobs se vuelven a juntar en la próxima corrida: {message}',
  'memory.collect.secretSkipped':          '{count} registro(s) con secreto salteado(s) — solo patrón y número de línea, nunca la línea encontrada.',
  'memory.collect.modifiedTrackedSkipped': '{count} registro(s) trackeado(s) y modificado(s) salteado(s) — hacé commit o stash y volvé a correrlo.',
  'memory.collect.worktreeSkipped': '{count} worktree(s) no se pudieron inspeccionar y quedaron excluidos de esta corrida: {paths}',

  // ── memory/cli.mjs — ship (issue #888, ADR-0034 L1/L2/L5) ────────────────────
  'memory.ship.done':             '✓ se envió {ref} — el pull request #{number} quedó armado.',
  'memory.ship.reconciled':       '✓ se reconcilió {ref} — el pull request #{number} quedó armado. No se envió nada nuevo.',
  'memory.ship.nothing':          'nada nuevo para enviar — {ref} ya coincide con origin.',
  'memory.ship.dryRun':           'plan — {ref} se enviaría. No se hizo push ni ninguna llamada al puerto.',
  'memory.ship.pushed':           '✓ se hizo push de {ref} a origin.',
  'memory.ship.prExisting':       'el pull request #{number} ya estaba abierto — se reutilizó, no se recreó.',
  'memory.ship.armed':            '✓ auto-merge armado en el pull request #{number}.',
  'memory.ship.autoMergeRefused': 'el auto-merge fue rechazado ({reason}) — el pull request queda abierto; la próxima corrida lo vuelve a armar.',
  'memory.ship.identityAmbient':  'BRAIN_MEMORY_TOKEN no está configurado — esta corrida se autenticó con la credencial ambiente de la sesión.',
  'memory.ship.diverged':         '✗ el envío falló — {ref} divergió de origin; no se forzó nada. {message}',
  'memory.ship.pushFailed':       '✗ el envío falló — el push no se concretó. {message}',
  // #1119: esta consulta corre antes del push (D4) — un fallo acá significa
  // que no se envió nada, no que el push se concretó. Reintentar es seguro:
  // la próxima corrida arranca de nuevo desde el mismo estado sin enviar.
  'memory.ship.prLookupFailed':   '✗ el envío falló — no se pudo consultar el pull request, así que su existencia es incomputable; en esta corrida no se envió nada. Reintentá una vez que la consulta funcione. {message}',
  // #1119: distinto de `prLookupFailed` — esta es la re-consulta de único
  // intento que corre DESPUÉS de que el push ya se concretó, así que a
  // diferencia del fallo de consulta previo al push, acá el push es real y
  // durable.
  'memory.ship.prLookupFailedAfterPush': '✗ el envío falló — el push ya se concretó, pero no se pudo encontrar el pull request después para confirmar su número. Reintentar es seguro — la próxima corrida lo reconcilia. {message}',
  'memory.ship.prCreateFailed':   '✗ el envío falló — no se pudo crear el pull request. {message}',
  'memory.ship.prNumberUnknown':  'el pull request está abierto pero no se pudo derivar su número — se salteó el auto-merge; la próxima corrida lo recupera.',
  // REVERSIÓN DE R8 (#920 -> #936, D4): una rama cuyo único pull request se
  // cerró sin fusionarse nunca se vuelve a enviar ni recibe un PR nuevo — se
  // reporta en cada corrida hasta que un operador borre la rama local.
  'memory.ship.closedUnmerged':   '⚠ no se envió {branch} — el pull request #{number} se cerró sin fusionarse; se seguirá reportando en cada corrida hasta que se borre la rama local.',
  'memory.ship.failed':           '✗ el envío falló — {message}',
  'memory.ship.raced':            '✗ el envío falló — la ref del lane se movió durante esta corrida (raced); no se perdió nada, sus blobs se vuelven a juntar en la próxima corrida: {message}',
  'memory.ship.badHost':          '✗ el envío falló — el nombre de host produjo un slug de ref vacío o inválido: {message}',
  'memory.ship.invokerMissing':   '✗ envío rechazado — pasá --invoker hook, sweep o manual; para correrlo a mano usá `npm run brain:memory:ship`.',
  'memory.ship.invokerUnderTest': '✗ envío rechazado — NODE_TEST_CONTEXT está configurado; un test debe usar BRAIN_VCS_TEST_MODULE o --dry-run, nunca un --invoker a secas.',
  'memory.ship.invokerInvalid':   '✗ envío rechazado — --invoker debe ser hook, sweep o manual; se recibió {value}.',

  // Lane sweep entre días, por rama, en stderr (#936, D-sweep paso 5.8) —
  // nunca condicionado por --json, misma disciplina que memory.ship.pushed/
  // prExisting/armed/identityAmbient de arriba. Mismas 8 acciones que
  // day.memory.laneSweep.branch.*.
  'memory.ship.sweep.deleted':        'lane sweep: {branch} ({date}) ya se había entregado por completo — se borró la rama local.',
  'memory.ship.sweep.shipped':        'lane sweep: {branch} ({date}) se volvió a enviar — pull request #{number}.',
  'memory.ship.sweep.reconciled':     'lane sweep: {branch} ({date}) se reconcilió — pull request #{number}, nada nuevo para enviar.',
  'memory.ship.sweep.closedUnmerged': 'lane sweep: {branch} ({date}) no se volvió a enviar — el pull request #{number} se cerró sin fusionarse.',
  'memory.ship.sweep.unknown':        'lane sweep: {branch} ({date}) tiene un estado ilegible — se mantiene, no se adivina.',
  'memory.ship.sweep.diverged':       'lane sweep: {branch} ({date}) divergió de su remoto — no se forzó nada.',
  'memory.ship.sweep.failed':         'lane sweep: {branch} ({date}) no se pudo reconciliar — {reason}',
  'memory.ship.sweep.remoteOnly':     'lane sweep: {branch} ({date}) sólo existe en el remoto — se reporta, no se modifica.',
  // #936 remediation: refleja memory.ship.sweepFailed en inglés — el sweep
  // completo falló, no hay filas de `branches` para recorrer.
  'memory.ship.sweepFailed':          'el lane sweep falló: {reason}, no se cambió ni reconcilió nada esta vez.',

  // ── memory/cli.mjs — qué backend corrió realmente (issue #641) ───────────────
  'memory.backend.undeclared': "no hay un backend de memoria declarado, así que `{op}` no va a adivinar uno. La elección del equipo va en la config versionada: `npm run brain:config -- set memory.backend engram` (o `plainfiles`). Override por corrida: MEMORY_BACKEND=<backend> (env o .env). O corré `npm run brain:env:init`, que pregunta una vez y lo escribe.",
  'memory.backend.invalid': "el backend de memoria '{value}' (de {source}) no es ninguno de: {allowed}. No se corrió nada. Corregilo donde está seteado: `npm run brain:config -- set memory.backend <backend>` para la config del equipo, o la línea MEMORY_BACKEND de .env.",
  'memory.backend.saveDeferred.undeclared': "no hay un backend de memoria declarado, así que este registro se guardó solo en .memory/records/ — la hidratación queda diferida hasta que se declare uno (`npm run brain:config -- set memory.backend engram|plainfiles`). El registro es durable; no se perdió nada.",
  'memory.backend.saveDeferred.invalid': "el backend de memoria declarado '{value}' no es un backend, así que este registro se guardó solo en .memory/records/ — la hidratación queda diferida hasta corregirlo (`npm run brain:config -- set memory.backend engram|plainfiles`). El registro es durable; no se perdió nada.",
  'memory.backend.shadowed': "el backend de memoria de {winner} ({backend}) pisa a {loser} ({other}) en esta corrida.",
  'memory.backend.substituted': "el binario `{from}` no está instalado acá, así que `{op}` corrió sobre el backend `{fallback}` (solo registros) — mismos registros, misma validación, sin backend requerido (ADR-0017). {source} sigue declarando `{from}` y eso no cambia: la hidratación en `{from}` queda diferida hasta instalarlo, y entonces volvé a correr `npm run brain:memory:{op}`.",
  'memory.backend.statedButAbsent': "{source} fija el backend de memoria en {backend} explícitamente, pero el binario `{backend}` no está en PATH acá — un selector explícito nunca se pisa (ADR-0004), así que esta corrida va a fallar. La captura solo-registros no necesita backend: `MEMORY_BACKEND={fallback} npm run brain:memory:{op}`.",
  'memory.backend.probeFailed': 'no se pudo determinar si el binario `{backend}` está presente — {reason}. Eso es la VERIFICACIÓN fallando, no el binario faltando, así que no se sustituyó nada y `{op}` sigue sobre `{backend}`. Si falla, la ruta solo-registros es `MEMORY_BACKEND={fallback} npm run brain:memory:{op}`.',

  // ── axes/memory/adapters/engram.mjs — share() secret scrub (issue #214, C1b) ──────
  'memory.share.unprovenanced': '{count} observación(es) llegaron sin bloque de provenance, así que se materializaron como `@legacy` y sin `issue` — todavía nada emite el bloque en el camino de captura (#541). Contadas, no rechazadas: rechazarlas voltearía el store que ya existe.',
  'memory.share.skippedHydrated': 'Se omitieron {count} observación(es) — su topic ya nombraba un registro (escrito por hydrate(), #874), así que reexportarlas habría generado un id duplicado.',
  'memory.share.secretFound': 'Se detectó un secreto en {file}:{line} — coincide con el patrón "{pattern}". Eliminá el secreto o agregá una entrada en governance.memorySecretAllowPatterns si es un falso positivo. Ejecutá `gunzip -c {file} | jq .` para inspeccionar (el número de línea corresponde a esa vista formateada).',

  // ── axes/memory/adapters/engram.mjs — alcance del export contra la base upstream del
  // exportador de records en dual-write (issue #701). Huérfana desde #874 split B
  // junto al resto de `memory.share.*` (D6) — el exportador también se retiró
  // ahora (#955 R5, epic task 2.4), así que estas claves ya no tienen lector.
  // Se dejan como están: ninguna ruling cubre borrar claves huérfanas del catálogo,
  // solo el código que las producía.
  'memory.share.upstreamUnavailable': 'no se pudo consultar la base upstream — {reason}. Esta corrida escribió todos los candidatos (comportamiento pre-#701); no se acotó nada.',
  'memory.share.upstreamConfigUnreadable': '{error}. Cualquier memory.upstreamRef declarado ahí NO fue respetado — la base upstream se derivó como {ref} en su lugar. Arreglá brain.config.json (un marcador de conflicto a medio merge es la causa habitual) si querías apuntar a otro ref.',
  'memory.share.upstreamConfigUnreadableNoRef': '{error}. Cualquier memory.upstreamRef declarado ahí NO fue respetado, y tampoco resolvió ninguna base upstream — la línea siguiente dice qué se intentó. Arreglá brain.config.json (un marcador de conflicto a medio merge es la causa habitual) si querías apuntar a otro ref.',
  'memory.share.upstreamUnnamed': '{count} archivo(s) bajo .memory/records/ en la base upstream no coinciden con el formato de nombre por registro y son invisibles para el chequeo de alcance del export. Corré `npm run brain:memory:split-records` para arreglarlo.',
  'memory.share.dedupedUpstream': '{count} registro(s) ya presentes en la base upstream ({ref}) no se re-exportaron.',

  // ── memory/staged-records-check.mjs — gate de pre-commit (issue #701) ────────
  'memory.stagedRecordsCheck.refused': 'rechazado — {count} archivo(s) de .memory/records/ en stage son byte-idénticos a una copia que ya está en el trunk. Esto no agrega nada y es lo que re-dispara este ticket. La solución no pierde información — los bytes ya son durables upstream:',
  'memory.stagedRecordsCheck.mergeUnreadable': 'hay un merge en curso pero no se pudieron leer sus padres — {error}. Los records que este merge está trayendo no se pueden distinguir de un re-commit, así que el veredicto de abajo es el previo al merge. NO borres con `rm` un record que el merge introdujo confiando en él.',
  'memory.stagedRecordsCheck.remedy': '  git restore --staged {paths}\n  (después hacé `rm` de las rutas que `git status` ahora muestre como sin trackear — mismos bytes, ya están en el trunk)',
  'memory.stagedRecordsCheck.unavailable': 'no se pudo consultar la base upstream — {note}. No se rechazó nada; esta corrida no pudo hacer la pregunta.',
  'memory.stagedRecordsCheck.configUnreadable': '{error}. Cualquier memory.upstreamRef declarado ahí NO fue respetado — la base upstream se derivó como {ref} en su lugar. Arreglá brain.config.json (un marcador de conflicto a medio merge es la causa habitual) si querías apuntar a otro ref.',
  'memory.stagedRecordsCheck.configUnreadableNoRef': '{error}. Cualquier memory.upstreamRef declarado ahí NO fue respetado, y tampoco resolvió ninguna base upstream — la línea siguiente dice qué se intentó. Arreglá brain.config.json (un marcador de conflicto a medio merge es la causa habitual) si querías apuntar a otro ref.',

  // ── axes/memory/adapters/engram.mjs — importMemory() pull solo-records (D2/C4, issue #229) ──
  'memory.import.empty':    'ℹ no se encontraron registros en .memory/records/ — nada para importar.',
  'memory.import.progress': '  ✓ {written}/{total} registros importados',
  'memory.import.done':     '✓ importación completa — {written}/{total} registros importados a engram (solo records, D2/C4).',
  'memory.import.contended': '⚠ hay otra hidratación corriendo (pid {pid}, empezó hace {age}s) — import OMITIDO para no duplicar registros. No se escribió nada; la próxima corrida reintenta.',
  'memory.import.stateUnreadable': '⚠ no se pudo leer el estado actual de engram — importación OMITIDA para no duplicar registros. Motivo: {reason}. No se escribió nada; volvé a correr la importación cuando engram responda.',

  // ── memory/cli.mjs — migrate-v1 (issue #217, C2a / #219 C2-migrate / #222 C2b-2) ──
  'memory.migrateV1.realRunSummary':        '✓ migración completa — escritos: {written} | rechazados: {rejected} | omitidos (personal): {skipped} | chunks no parseables: {unparseable} | chunks sin observaciones: {emptyObservations} | índice: {indexCount} registro(s). records/ es ahora la única vía de escritura (memory.dualWrite retirado, D3/C4).',
  'memory.migrateV1.rollbackRetired':       'migrate-v1 --rollback fue retirado (#955): antes restauraba los chunks v1 desde .memory/legacy/ y después borraba .memory/records/, destruyendo cada registro capturado desde la migración. Este rechazo no lee ni escribe nada — los chunks v1 están donde ya estaban: en .memory/legacy/ si ese directorio existe localmente, o en el historial de git si no: git show <sha>:.memory/legacy/<file>',
  'memory.migrateV1.dryRunHeader':          'Reporte de migración en dry-run (issue #217, C2):',
  'memory.migrateV1.summary':               'registros: {records} | omitidos (personal): {skipped} | rechazados: {rejected} | chunks no parseables: {unparseable} | chunks sin observaciones: {emptyObservations}',
  'memory.migrateV1.typesHistogramHeader':  'Histograma de tipos:',
  'memory.migrateV1.provenanceHistogramHeader': 'Histograma de procedencia: {recovered} recuperados / {fallback} por convención de respaldo',
  'memory.migrateV1.rejectedHeader':        'Registros rechazados:',
  'memory.migrateV1.emptyObservationsHeader': 'Chunks solo de sesiones/prompts (observations: null — no es corrupción, 0 observaciones aportadas):',
  'memory.migrateV1.unparseableHeader':     'Archivos chunk no parseables (corrupción real — cantidad de observaciones desconocida):',

  // ── memory/lib/unsupported-op.mjs — helper compartido de rechazo explícito (C3, issue #246) ──
  'memory.op.unsupported':            "la operación '{op}' no está soportada por el backend de memoria '{backend}' (diferida — ver openspec/changes/issue-246-c3).",
  // memory.save.engramUnsupported se retiró en #874, split A (D7) — su único
  // call site (engram.mjs#save) ahora es el camino productor record-first.
  'memory.search.engramUnsupported':  "'{op}' no es un verbo de cli para el backend '{backend}' — usá el mem_search nativo de engram / 'engram search' en su lugar.",

  // ── axes/memory/adapters/plainfiles.mjs — verbos cli save/search (C3, issue #246) ──
  'memory.plainfiles.save.issueInvalid': '--issue tiene que ser un NÚMERO de issue; llegó {value}. Se guarda como entero para que el registro quede atado a su ticket.',
  'memory.plainfiles.save.typeRequired': '--type es obligatorio y no tiene default seguro — es una elección, no un dato que la herramienta pueda derivar. Uno de: {types}.',
  'memory.plainfiles.save.done':    '✓ guardado {id} → {file}',
  'memory.plainfiles.save.indexFailed': 'el registro SÍ se escribió — {id} → {file}. Lo que falló es la reconstrucción del ÍNDICE, que lee el store entero, así que la causa casi seguro es un registro que ya estaba roto antes de esta corrida: {message}\n  NO vuelvas a correr brain:memory:save — el registro ya está en disco, y reintentar acuña un SEGUNDO registro con un `ts` posterior, y por lo tanto otro id, que ninguna deduplicación va a colapsar jamás.\n  Repará el store y después reconstruí el índice con `npm run brain:memory:reindex`.',
  'memory.plainfiles.save.secretFound': 'Se detectó un secreto en el registro candidato (línea {line}) — coincide con el patrón "{pattern}". Se abortó ANTES de agregarlo a records/ (agregá una entrada en governance.memorySecretAllowPatterns si es un falso positivo).',
  // ── #738 — proveniencia en la captura: actor/actorKind/issue ─────────────
  'memory.plainfiles.save.actorUnset': 'no hay un actor configurado — corré `git config --local brain.actor @<handle>` una vez por clon y reintentá. brain.actor no está configurado.',
  'memory.plainfiles.save.actorMalformed': "brain.actor está configurado como '{value}', que no tiene forma de handle (tiene que empezar con @, por ejemplo @tuhandle). Corré `git config --local brain.actor @<handle>` para arreglarlo.",
  'memory.plainfiles.save.actorReserved': "brain.actor está configurado como '{value}', un valor reservado de uso interno para registros sin atribución/legacy — no se puede usar como actor de captura. Corré `git config --local brain.actor @<handle>` con tu propio handle.",
  'memory.plainfiles.save.issueDerived': 'issue {issue} derivado de la rama {branch} (no se pasó --issue).',
  'memory.save.plainfilesIgnoredOpts': 'se ignoraron la(s) opción(es) {opts} — el formato de registro de plainfiles no tiene un campo para ellas (scope/topic son conceptos exclusivos de engram); el registro se guardó igualmente.',
  'memory.save.engramIgnoredOpts': "se ignoraron la(s) opción(es) {opts} — la hidratación siempre define su propio scope ('project') y topic (el id del propio registro); los valores pasados acá se descartaron, no se combinaron, y el registro se guardó igualmente.",
  // ── --supersedes (#805): un id de supersedes se verifica contra el store, local primero, antes de cualquier escritura ──
  'memory.plainfiles.save.supersedesMalformed': "--supersedes '{value}' no tiene la forma rec-<16 hex> — se rechazó antes de tocar el filesystem o git, y no se escribió ningún registro.",
  'memory.plainfiles.save.supersedesNotInStore': "--supersedes {id} no está en el store — se revisó .memory/records/ local y {ref}. Subilo en la lane primero y después corregilo; no se escribió ningún registro.",
  'memory.plainfiles.save.supersedesUnverifiable': "--supersedes {id} no se pudo verificar: {reason}. Arreglalo con `git fetch origin main`, o apuntá BRAIN_MEMORY_UPSTREAM_REF / memory.upstreamRef a un ref que resuelva; no se escribió ningún registro.",
  'memory.plainfiles.save.supersedesConfigError': 'no se pudo leer brain.config.json mientras se verificaba --supersedes: {error}. La verificación igual corrió contra el ref que resolvió sin él.',
  'memory.save.supersedesRepeated': '--supersedes acepta exactamente un id por guardado — el fan-in (varios registros superando el mismo id) está diferido (#805). Se rechazó antes de cualquier escritura.',
  'memory.save.supersedesMissingValue': '--supersedes necesita un valor (el id que supera) — se rechazó antes de cualquier escritura, para que el registro nunca se guarde en silencio sin el campo que pediste.',
  // ── #874 — hydrate({recordId}): el registro ya es durable antes de que esto corra, así que
  // una falla del backend acá se reporta, nunca se lanza (R5) ──
  'memory.save.hydrateDeferred': 'el registro {recordId} está en disco, pero hidratarlo en engram quedó diferido — {reason}. El registro NO se perdió; volvé a correr `npm run brain:memory:pull` (o `brain:memory:share`) cuando engram esté disponible para ponerlo al día.',
  'memory.save.hydrateContended': 'el registro {recordId} está en disco, pero hidratarlo en engram se saltó — otro proceso (pid {pid}, {age}s) tiene tomado el guard de hidratación #820. El registro NO se perdió; se va a recoger en el próximo pull/share.',
  'memory.hydrate.recordNotFound': "hydrate: no se encontró ningún registro con id '{recordId}' bajo .memory/records/ — pasá el registro mismo al hidratar uno que todavía no se leyó de disco.",
  'memory.plainfiles.search.empty': 'ℹ no se encontraron registros coincidentes.',
  'memory.plainfiles.search.summary': '{count} registro(s) coincidente(s):',

  // ── brain-protect.mjs — arm-and-verify (issue #203) ───────────────────────────
  'protect.verify.unverifiable': '  Verificar: aún no hay check-runs en {branch} — no verificable hasta el primer PR.',
  'protect.verify.missing':      '  AVISO    : el check requerido "{context}" no tiene check-run coincidente aún — confirmar que el nombre del job sea exacto.',
  'protect.verify.unsupported':  '  Verificar: verificación por check-runs no soportada en el provider {provider} — los contexts armados no se cruzan.',
};
