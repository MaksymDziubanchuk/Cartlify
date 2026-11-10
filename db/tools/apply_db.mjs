// brings a database (dev or prod) to the structure of this code: npm run db:apply. It first asks
// the database, read only, what it needs: the migrations not applied yet (prisma migrate status)
// and whether its structure is the one of db/tools/structure_snapshot.txt (the functions with their
// bodies, the policies, the triggers, the indexes, the rights). When nothing is waiting and the
// structure matches, it applies nothing and the app may keep running. Otherwise, on a stopped app,
// it applies the migrations that wait, then the sql scripts, always all six and in their order (02
// as a superuser; 05, 03, 04, 06 as cartlify_owner; 01 as a superuser, last: a migration may drop
// what a script makes, and every script runs again without a change), then checks the structure
// again. It stops at the first step that fails.
// The two addresses are asked at the start (the superuser and cartlify_owner of that database) and
// typed or pasted into the terminal, never into a file; a star shows for every sign. It needs a
// terminal: PowerShell, cmd, or winpty in Git Bash (whose window gives it none, the script says so). The output never shows a user, a password, a
// host or a port of them. Needs psql on the PATH.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// parameters prisma reads from a url and libpq does not know
const PRISMA_PARAMS = [
  'schema',
  'connection_limit',
  'pool_timeout',
  'pgbouncer',
  'socket_timeout',
  'statement_cache_size',
];

const SCRIPTS = [
  ['02_extensions.sql', 'superuser'],
  ['05_fn_and_triggers.sql', 'owner'],
  ['03_policies_and_rls.sql', 'owner'],
  ['04_views.sql', 'owner'],
  ['06_indexes_and_constraints.sql', 'owner'],
  ['01_roles_and_schemas.sql', 'superuser'],
];

const PRISMA_CLI = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const SNAPSHOT_TOOL = path.join(ROOT, 'db', 'tools', 'structure_snapshot.mjs');

// one reader for every question: the lines are queued, so answers that come piped all at once
// still meet their questions; an answer marked hidden shows a star for every sign typed or pasted
// when stdin is a terminal, so the person sees it arrive without seeing it
const terminal = Boolean(process.stdin.isTTY);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal });
let hiding = false;
let prompt = '';
const writeToOutput = rl._writeToOutput.bind(rl);
rl._writeToOutput = (text) => {
  if (!hiding) return writeToOutput(text);
  // readline draws the whole line again (a backspace, a paste): the prompt and stars for the rest
  if (prompt && text.startsWith(prompt)) {
    return writeToOutput(prompt + '*'.repeat(text.length - prompt.length));
  }
  if (text.includes('\n') || text.includes('\r')) return writeToOutput('\n');
  return writeToOutput('*'.repeat(text.length));
};

const lines = [];
let waiting = null;
rl.on('line', (line) => {
  if (waiting) waiting(line);
  else lines.push(line);
});
rl.on('close', () => waiting?.(''));

function ask(question, { hidden = false } = {}) {
  if (terminal) {
    prompt = question;
    rl.setPrompt(question);
    rl.prompt();
  } else {
    process.stdout.write(question);
  }
  if (lines.length) {
    if (!terminal) process.stdout.write('\n');
    return Promise.resolve(lines.shift().trim());
  }
  hiding = hidden && terminal;
  return new Promise((resolve) => {
    waiting = (line) => {
      waiting = null;
      hiding = false;
      if (!terminal) process.stdout.write('\n');
      resolve(line.trim());
    };
  });
}

function parse(label, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label}: not an address`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${label}: not a postgres address`);
  }
  if (!url.username || !url.hostname || url.pathname.length < 2) {
    throw new Error(`${label}: the user, the host and the database are needed`);
  }
  return url;
}

// the address for psql: the parameters of prisma dropped
function forPsql(url) {
  const clean = new URL(url);
  for (const name of PRISMA_PARAMS) clean.searchParams.delete(name);
  return clean.toString();
}

// the address for prisma: the tables live in the schema cartlify
function forPrisma(url) {
  const withSchema = new URL(url);
  if (!withSchema.searchParams.has('schema')) withSchema.searchParams.set('schema', 'cartlify');
  return withSchema.toString();
}

// the parts of the addresses the output must not show: the addresses, the passwords, the hosts and
// the ports (the names of the roles are no secret, the check of the structure names them)
function masker(urls) {
  const secrets = new Set();
  for (const url of urls) {
    for (const part of [url.toString(), forPsql(url), forPrisma(url), url.password, url.hostname]) {
      if (part) secrets.add(part);
      if (part) secrets.add(decodeURIComponent(part));
    }
  }
  const ports = [...new Set(urls.map((url) => url.port).filter(Boolean))];
  const sorted = [...secrets].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
  return (line) => {
    let out = line;
    for (const secret of sorted) out = out.split(secret).join('***');
    for (const port of ports) out = out.replace(new RegExp(`\\b${port}\\b`, 'g'), '***');
    return out
      .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
      .replace(/port \d+/gi, 'port ***')
      .replace(/postgres(ql)?:\/\/\S+/gi, '<address>');
  };
}

// the tools answer in English: the messages the mask knows, whatever the language of the system
const ENGLISH = { LC_ALL: 'C', LC_MESSAGES: 'C', LANG: 'C', LANGUAGE: 'en' };

function run(title, command, args, env, mask) {
  return new Promise((resolve) => {
    process.stdout.write(`\n== ${title}\n`);
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...ENGLISH, ...env } });
    const pipe = (stream, out) => {
      let rest = '';
      stream.on('data', (chunk) => {
        const lines = (rest + chunk.toString()).split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const line of lines) out.write(mask(line) + '\n');
      });
      stream.on('end', () => {
        if (rest) out.write(mask(rest) + '\n');
      });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on('error', (err) => {
      process.stderr.write(mask(`${title}: ${err.message}`) + '\n');
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// a step whose output is read, not shown: its exit code and all it printed
function capture(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...ENGLISH, ...env } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk.toString()));
    child.stderr.on('data', (chunk) => (out += chunk.toString()));
    child.on('error', (err) => resolve({ code: 1, out: out + err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

async function main() {
  // the window of Git Bash (mintty) gives node no terminal: what is typed or pasted never reaches
  // it; winpty, PowerShell or cmd give one (answers piped in still work, no terminal needed)
  if (
    !terminal &&
    process.env.MSYSTEM &&
    process.stdin.readableLength === 0 &&
    !process.env.APPLY_DB_PIPED
  ) {
    console.log(
      'Git Bash gives this script no terminal, so the addresses cannot be typed here.\n' +
        'Run it as: winpty node db/tools/apply_db.mjs   (or npm run db:apply in PowerShell)',
    );
    return 1;
  }

  const superuser = parse('superuser', await ask('Address of the superuser: ', { hidden: true }));
  const owner = parse(
    'owner',
    await ask('Address of the owner (the role that owns the tables and the functions): ', {
      hidden: true,
    }),
  );
  const mask = masker([superuser, owner]);

  const database = owner.pathname.slice(1);
  if (superuser.pathname.slice(1) !== database || superuser.hostname !== owner.hostname) {
    throw new Error('the two addresses are of different databases');
  }

  // what the database needs, read only
  process.stdout.write('\n== what the database needs\n');
  const status = await capture(process.execPath, [PRISMA_CLI, 'migrate', 'status'], {
    DATABASE_URL: forPrisma(owner),
  });
  const pending = /have not yet been applied/i.test(status.out);
  if (!pending && !/Database schema is up to date/i.test(status.out)) {
    // a migration that failed, or a history the database and the code do not share: by hand
    process.stdout.write(mask(status.out.trim()) + '\n');
    console.log('Stopped: the history of the migrations needs a look before anything is applied.');
    return 1;
  }
  const waiting = status.out.match(/^\d{14}_\w+$/gm) ?? [];
  const check = await capture(process.execPath, [SNAPSHOT_TOOL, 'check', 'db'], {
    DATABASE_URL: owner.toString(),
  });
  const matches = check.code === 0;
  console.log(`migrations waiting: ${pending ? waiting.join(', ') || 'some' : 'none'}`);
  console.log(
    `structure: ${matches ? 'the one of this code' : 'differs from the one of this code'}`,
  );
  if (!matches) {
    const lines = check.out.split(/\r?\n/).filter((line) => /^\s+only in /.test(line));
    for (const line of lines.slice(0, 10)) console.log(mask(line));
    if (lines.length > 10) console.log(`  ... and ${lines.length - 10} more`);
  }
  if (!pending && matches) {
    console.log('\nNothing to apply: the database has the structure of this code already.');
    return 0;
  }

  const steps = [pending ? 'the migrations that wait' : null, 'the six scripts', 'the check']
    .filter(Boolean)
    .join(', ');
  const answer = await ask(
    `Apply ${steps} to the database "${database}"? The app must be stopped. Type yes: `,
  );
  if (answer !== 'yes') {
    console.log('Nothing done.');
    return 0;
  }

  if (pending) {
    const code = await run(
      'migrations',
      process.execPath,
      [PRISMA_CLI, 'migrate', 'deploy'],
      { DATABASE_URL: forPrisma(owner) },
      mask,
    );
    if (code !== 0) return code;
  }

  for (const [file, role] of SCRIPTS) {
    const url = role === 'superuser' ? superuser : owner;
    const code = await run(
      // the role as the address names it
      `${file} (${decodeURIComponent(url.username)})`,
      'psql',
      ['-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join('db', 'schema', file), forPsql(url)],
      // the notices of a script that runs again (already exists, skipping) say nothing new
      { PGOPTIONS: '-c client_min_messages=warning' },
      mask,
    );
    if (code !== 0) return code;
  }

  const code = await run(
    'the check of the structure',
    process.execPath,
    [SNAPSHOT_TOOL, 'check', 'db'],
    { DATABASE_URL: owner.toString() },
    mask,
  );
  if (code !== 0) return code;

  console.log('\nDone: the structure is applied and matches the reference. Deploy the app again.');
  return 0;
}

main()
  .then((code) => {
    rl.close();
    process.exit(code);
  })
  .catch((err) => {
    rl.close();
    console.error(`Stopped: ${err.message}`);
    process.exit(1);
  });
