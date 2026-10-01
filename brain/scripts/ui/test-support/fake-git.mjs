// fake-git.mjs — an in-memory `git` for the injected `run(file, args, opts)`
// seam (#1198). It models exactly the commands the document reader and the
// change route issue, and throws on every other one so a test cannot pass on
// a call nobody modelled.
//
//   fakeGit({ files, head, branches, blame, modes, trees, sizes, fail })
//     files     {path: text} committed at HEAD
//     head      the HEAD commit id (40 hex)
//     branches  {name: {commit, files}} — refs other than HEAD
//     blame     the text `git blame` answers; absent = blame is unmodelled
//     modes     {path: '120000'} — override a path's tree mode
//     trees     [path] — paths that are trees, not blobs
//     sizes     {path: n} — the size ls-tree reports, without allocating n bytes
//     fail      {subcommand | 'subcommand:path': message} or (args) => message|Error|null
//
// `run.calls` is every argv in order; `run.opts` the matching third arguments.

import { createHash } from 'node:crypto';

const HEAD_DEFAULT = 'a'.repeat(40);
const blobId = (path, text) => createHash('sha1').update(`${path}\0${text}`).digest('hex');
const globToRe = (glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

export function fakeGit({ files = {}, head = HEAD_DEFAULT, branches = {}, blame, modes = {}, trees = [], sizes = {}, fail } = {}) {
  const calls = [];
  const optsLog = [];

  const refs = { HEAD: { commit: head, files }, [head]: { commit: head, files } };
  for (const [name, b] of Object.entries(branches)) {
    refs[name] = { commit: b.commit, files: b.files ?? {} };
    refs[b.commit] ??= refs[name]; // a commit id resolves to the tree it names, as in git
  }
  const blobs = new Map();
  for (const ref of Object.values(refs)) for (const [p, t] of Object.entries(ref.files)) blobs.set(blobId(p, t), { path: p, text: t });

  const refOf = (name) => {
    if (!refs[name]) throw new Error(`fatal: bad revision '${name}'`);
    return refs[name];
  };

  const injected = (args, path) => {
    if (!fail) return null;
    const verdict = typeof fail === 'function' ? fail(args) : (fail[`${args.find((a) => /^[a-z-]+$/.test(a) && a !== 'git')}:${path}`] ?? fail[args.find((a) => /^[a-z-]+$/.test(a))]);
    if (!verdict) return null;
    return verdict instanceof Error ? verdict : new Error(String(verdict));
  };

  function run(file, args, opts) {
    calls.push(args);
    optsLog.push(opts);
    if (file !== 'git') throw new Error(`fake-git: unmodelled program ${file}`);
    const argv = args[0] === '--literal-pathspecs' ? args.slice(1) : args;
    const [sub, ...rest] = argv;
    const failure = injected(argv, sub === 'cat-file' ? blobs.get(rest[1])?.path : sub === 'show' ? rest[0]?.split(':')[1] : undefined);
    if (failure) throw failure;

    if (sub === 'rev-parse' && rest[0] === '--verify') return `${refOf(rest[1].replace(/\^\{commit\}$/, '')).commit}\n`;

    if (sub === 'ls-tree' && rest[0] === '-l' && rest[1] === '-z') {
      const ref = refOf(rest[2]);
      const paths = rest.slice(rest.indexOf('--') + 1);
      let out = '';
      for (const p of paths) {
        if (trees.includes(p)) { out += `040000 tree ${blobId(p, '')}      -\t${p}\0`; continue; }
        if (!(p in ref.files)) continue;
        const text = ref.files[p];
        const size = sizes[p] ?? Buffer.byteLength(text);
        out += `${modes[p] ?? '100644'} blob ${blobId(p, text)} ${String(size).padStart(7)}\t${p}\0`;
      }
      return out;
    }

    if (sub === 'cat-file' && rest[0] === 'blob') {
      const blob = blobs.get(rest[1]);
      if (!blob) throw new Error(`fatal: Not a valid object name ${rest[1]}`);
      if (opts?.maxBuffer !== undefined && Buffer.byteLength(blob.text) > opts.maxBuffer) {
        throw Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
      }
      return blob.text;
    }

    if (sub === 'show' && /^[^:]+:.+/.test(rest[0] ?? '')) {
      const [ref, path] = [rest[0].slice(0, rest[0].indexOf(':')), rest[0].slice(rest[0].indexOf(':') + 1)];
      const files_ = refOf(ref).files;
      if (!(path in files_)) throw new Error(`fatal: path '${path}' does not exist in '${ref}'`);
      return files_[path];
    }

    if (sub === 'blame') {
      if (blame === undefined) throw new Error('fake-git: no blame modelled');
      return typeof blame === 'function' ? blame(argv) : blame;
    }

    if (sub === 'branch' && rest[0] === '--list') {
      const re = globToRe(rest[1] ?? '*');
      const names = Object.keys(branches).filter((n) => re.test(n));
      return names.map((n) => `  ${n}\n`).join('');
    }

    throw new Error(`fake-git: unmodelled command git ${args.join(' ')}`);
  }

  run.calls = calls;
  run.opts = optsLog;
  return run;
}
