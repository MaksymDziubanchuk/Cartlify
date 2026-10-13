// structure snapshot of schema cartlify: one text line per object, data is not read
// the reference describes what the scripts in the repo build, real databases are compared with it
// usage: node db/structure_snapshot.mjs save | check | check db
//   save     - read the structure of the local test container and store it as the reference
//   check    - compare the local test container with the reference
//   check db - compare the database from DATABASE_URL with the reference
//              (dev from .env locally, dev or prod secret in the github workflow)
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;

const here = path.dirname(fileURLToPath(import.meta.url));
const referenceFile = path.join(here, 'structure_snapshot.txt');

// local container address, must match db/test_db_build.mjs
const CONTAINER_URL =
  'postgresql://cartlify_app:cartlify_app@127.0.0.1:54329/cartlify_test?schema=cartlify';

// print privileges in a stable order
const acl = (column) =>
  `coalesce((select string_agg(a::text, ',' order by a::text) from unnest(${column}) a), '-')`;

// keep multi-line definitions on one line
const oneLine = (expr) => `regexp_replace(${expr}, '[[:space:]]+', ' ', 'g')`;

// every query returns ready text lines, so the snapshot does not depend on the client
const QUERIES = [
  `select concat_ws(' | ', 'server', current_setting('server_version')) as line`,

  `select concat_ws(' | ', 'database', current_setting('server_encoding'),
          coalesce(datcollate, '-'), coalesce(datctype, '-'), ${acl('datacl')}) as line
   from pg_database where datname = current_database()`,

  `select concat_ws(' | ', 'extension', e.extname, e.extversion, n.nspname,
          pg_get_userbyid(e.extowner)) as line
   from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   order by e.extname`,

  `select concat_ws(' | ', 'role', rolname, 'super=' || rolsuper, 'inherit=' || rolinherit,
          'createrole=' || rolcreaterole, 'createdb=' || rolcreatedb, 'login=' || rolcanlogin,
          'replication=' || rolreplication, 'bypassrls=' || rolbypassrls,
          'connlimit=' || rolconnlimit, coalesce(array_to_string(rolconfig, ','), '-')) as line
   from pg_roles where rolname like 'cartlify_%'
   order by rolname`,

  `select concat_ws(' | ', 'role_db_setting', coalesce(r.rolname, '*'),
          'in_database=' || (s.setdatabase <> 0), array_to_string(s.setconfig, ',')) as line
   from pg_db_role_setting s
   left join pg_roles r on r.oid = s.setrole
   where (r.rolname like 'cartlify_%' and s.setdatabase <> 0)
      or (s.setrole = 0
          and s.setdatabase = (select oid from pg_database where datname = current_database()))
   order by 1`,

  `select concat_ws(' | ', 'membership', r.rolname || ' is member of ' || g.rolname) as line
   from pg_auth_members m
   join pg_roles r on r.oid = m.member
   join pg_roles g on g.oid = m.roleid
   where r.rolname like 'cartlify_%' or g.rolname like 'cartlify_%'
   order by 1`,

  `select concat_ws(' | ', 'schema', n.nspname, pg_get_userbyid(n.nspowner),
          ${acl('n.nspacl')}) as line
   from pg_namespace n where n.nspname in ('cartlify', 'public')
   order by n.nspname`,

  `select concat_ws(' | ', 'table', c.relname, pg_get_userbyid(c.relowner),
          'rls=' || c.relrowsecurity, 'force=' || c.relforcerowsecurity, ${acl('c.relacl')}) as line
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'cartlify' and c.relkind in ('r', 'p')
   order by c.relname`,

  `select concat_ws(' | ', 'column', c.relname,
          (row_number() over (partition by c.oid order by a.attnum))::text, a.attname,
          format_type(a.atttypid, a.atttypmod), 'notnull=' || a.attnotnull,
          'default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-'),
          'identity=' || coalesce(nullif(a.attidentity::text, ''), '-'),
          'generated=' || coalesce(nullif(a.attgenerated::text, ''), '-'),
          ${acl('a.attacl')}) as line
   from pg_attribute a
   join pg_class c on c.oid = a.attrelid
   join pg_namespace n on n.oid = c.relnamespace
   left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname = 'cartlify' and c.relkind in ('r', 'p') and a.attnum > 0
     and not a.attisdropped
   order by c.relname, a.attnum`,

  `select concat_ws(' | ', 'constraint', c.relname, con.conname, con.contype::text,
          'validated=' || con.convalidated, ${oneLine('pg_get_constraintdef(con.oid)')}) as line
   from pg_constraint con
   join pg_class c on c.oid = con.conrelid
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'cartlify'
   order by c.relname, con.conname`,

  `select concat_ws(' | ', 'index', t.relname, i.relname, 'valid=' || x.indisvalid,
          'ready=' || x.indisready, ${oneLine('pg_get_indexdef(x.indexrelid)')}) as line
   from pg_index x
   join pg_class i on i.oid = x.indexrelid
   join pg_class t on t.oid = x.indrelid
   join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'cartlify'
   order by t.relname, i.relname`,

  `select concat_ws(' | ', 'sequence', c.relname, pg_get_userbyid(c.relowner),
          format_type(s.seqtypid, null), 'increment=' || s.seqincrement, 'start=' || s.seqstart,
          'cycle=' || s.seqcycle, ${acl('c.relacl')}) as line
   from pg_sequence s
   join pg_class c on c.oid = s.seqrelid
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'cartlify'
   order by c.relname`,

  `select concat_ws(' | ', 'enum', t.typname, pg_get_userbyid(t.typowner),
          (select string_agg(e.enumlabel, ',' order by e.enumsortorder)
             from pg_enum e where e.enumtypid = t.oid),
          ${acl('t.typacl')}) as line
   from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'cartlify' and t.typtype = 'e'
   order by t.typname`,

  // body hash ignores carriage returns: a script run from windows leaves crlf in the body
  `select concat_ws(' | ', 'function',
          p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
          pg_get_userbyid(p.proowner), l.lanname, 'definer=' || p.prosecdef,
          'volatile=' || p.provolatile::text, 'strict=' || p.proisstrict,
          'leakproof=' || p.proleakproof, 'parallel=' || p.proparallel::text,
          'returns=' || coalesce(pg_get_function_result(p.oid), '-'),
          'config=' || coalesce(array_to_string(p.proconfig, ','), '-'),
          'acl=' || ${acl('p.proacl')},
          'body=' || md5(replace(coalesce(p.prosrc, ''), chr(13), '')),
          'extension=' || coalesce(ext.extname, '-')) as line
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   join pg_language l on l.oid = p.prolang
   left join pg_depend dep
     on dep.classid = 'pg_proc'::regclass and dep.objid = p.oid and dep.deptype = 'e'
   left join pg_extension ext on ext.oid = dep.refobjid
   where n.nspname = 'cartlify'
   order by 1`,

  `select concat_ws(' | ', 'trigger', c.relname, t.tgname, 'enabled=' || t.tgenabled::text,
          ${oneLine('pg_get_triggerdef(t.oid)')}) as line
   from pg_trigger t
   join pg_class c on c.oid = t.tgrelid
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'cartlify' and not t.tgisinternal
   order by c.relname, t.tgname`,

  `select concat_ws(' | ', 'policy', tablename, policyname, permissive,
          array_to_string(roles, ','), cmd,
          'using=' || coalesce(${oneLine('qual')}, '-'),
          'check=' || coalesce(${oneLine('with_check')}, '-')) as line
   from pg_policies where schemaname = 'cartlify'
   order by tablename, policyname`,

  `select concat_ws(' | ', 'view', c.relname, pg_get_userbyid(c.relowner),
          'options=' || coalesce(array_to_string(c.reloptions, ','), '-'),
          'acl=' || ${acl('c.relacl')},
          'body=' || md5(replace(pg_get_viewdef(c.oid, true), chr(13), ''))) as line
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'cartlify' and c.relkind in ('v', 'm')
   order by c.relname`,

  `select concat_ws(' | ', 'default_acl', pg_get_userbyid(d.defaclrole),
          coalesce(n.nspname, '*'), d.defaclobjtype::text, ${acl('d.defaclacl')}) as line
   from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
   order by 1`,

  `select concat_ws(' | ', 'event_trigger', evtname, evtevent, evtenabled::text) as line
   from pg_event_trigger
   order by evtname`,
];

// describe the target without the password
function describeTarget(url) {
  const u = new URL(url);

  return `${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)} as ${decodeURIComponent(u.username)}`;
}

async function takeSnapshot(url) {
  const prisma = new PrismaClient({ datasourceUrl: url });

  try {
    return await prisma.$transaction(
      async (tx) => {
        // the snapshot only reads system catalogs
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');

        const lines = [];

        for (const sql of QUERIES) {
          const rows = await tx.$queryRawUnsafe(sql);

          for (const row of rows) lines.push(row.line);
        }

        return lines;
      },
      { maxWait: 20_000, timeout: 60_000 },
    );
  } finally {
    await prisma.$disconnect();
  }
}

// count lines per object kind for a short summary
function summarize(lines) {
  const counts = new Map();

  for (const line of lines) {
    const kind = line.split(' | ')[0];
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return [...counts].map(([kind, count]) => `${kind}=${count}`).join(' ');
}

// scripts in the order they must be run, with the way each one is run
const FIX_STEPS = [
  [
    'migrations',
    'prisma migrations (workflow "PROD DB — Prisma migrate deploy" or npm run migrate:deploy)',
  ],
  ['01', 'db/01_roles_and_schemas.sql (psql as superuser)'],
  ['02', 'db/02_extensions.sql (psql as superuser)'],
  ['05', 'db/05_fn_and_triggers.sql (workflow "DB — run SQL script")'],
  ['03', 'db/03_policies_and_rls.sql (workflow "DB — run SQL script")'],
  ['04', 'db/04_views.sql (workflow "DB — run SQL script")'],
  ['06', 'db/06_indexes_and_constraints.sql (workflow "DB — run SQL script")'],
  ['migrations-or-06', 'prisma migrations or db/06_indexes_and_constraints.sql'],
];

// kinds whose third field is the owner of the object
const KINDS_WITH_OWNER = ['schema', 'table', 'sequence', 'enum', 'function', 'view'];

// position of the privileges field for kinds that get their grants from db/01
const ACL_FIELD = { table: 5, sequence: 7, enum: 4, column: 9 };

// fields that identify one object, so its reference line can be paired with the database line
function objectKey(fields) {
  const [kind] = fields;

  if (kind === 'column') return `column | ${fields[1]} | ${fields[3]}`;
  if (['constraint', 'index', 'trigger', 'policy'].includes(kind)) {
    return fields.slice(0, 3).join(' | ');
  }
  if (kind === 'default_acl') return fields.slice(0, 4).join(' | ');
  if (['server', 'database'].includes(kind)) return kind;
  if (['membership', 'role_db_setting', 'event_trigger'].includes(kind)) return fields.join(' | ');

  return fields.slice(0, 2).join(' | ');
}

// guess which script brings one differing object in line with the reference
function guessFix(ref, actual) {
  // scripts never drop objects they do not know about
  if (!ref) return { manual: 'exists only in the database, scripts do not remove it' };

  const [kind, name] = ref;
  const changed = actual ? ref.flatMap((field, i) => (field === actual[i] ? [] : [i])) : [];
  const onlyAclChanged = changed.length === 1 && changed[0] === ACL_FIELD[kind];

  if (['server', 'database', 'event_trigger'].includes(kind)) {
    return { manual: 'server or database setting, scripts do not manage it' };
  }

  // create or replace keeps the owner, so rerunning a script does not change it
  if (actual && KINDS_WITH_OWNER.includes(kind) && changed.includes(2)) {
    return { manual: 'owner differs, scripts keep the owner of an existing object' };
  }

  if (kind === 'function') {
    const fromExtension = !ref[ref.length - 1].endsWith('extension=-');

    if (name.startsWith('immutable_unaccent(')) {
      return actual
        ? { manual: 'db/02 creates this function only when it is missing, the existing text stays' }
        : { step: '02' };
    }

    return { step: fromExtension ? '02' : '05' };
  }

  if (kind === 'extension') return { step: '02' };
  if (['role', 'role_db_setting', 'membership', 'schema', 'default_acl'].includes(kind)) {
    return { step: '01' };
  }
  if (kind === 'trigger') return { step: '05' };
  if (kind === 'policy') return { step: '03' };
  if (kind === 'view') return { step: '04' };

  // check constraints come from db/06, keys and foreign keys from migrations
  if (kind === 'constraint') return { step: ref[3] === 'c' ? '06' : 'migrations' };

  if (kind === 'index') {
    return { step: ref[2] === 'products_name_unaccent_trgm_idx' ? '02' : 'migrations-or-06' };
  }

  if (kind === 'table' && actual) {
    // row level security flags are set in db/03, grants in db/01
    if (changed.includes(3) || changed.includes(4)) return { step: '03' };
    if (onlyAclChanged) return { step: '01' };
  }

  if (['sequence', 'enum', 'column'].includes(kind) && actual && onlyAclChanged) {
    return { step: '01' };
  }

  // tables, columns, enums and sequences are created by migrations
  return { step: 'migrations' };
}

// print which scripts most likely bring the database in line with the reference
function printSuggestions(missing, extra) {
  const refByKey = new Map(
    missing.map((line) => [objectKey(line.split(' | ')), line.split(' | ')]),
  );
  const actualByKey = new Map(
    extra.map((line) => [objectKey(line.split(' | ')), line.split(' | ')]),
  );

  const bySteps = new Map();
  const byReason = new Map();

  for (const key of new Set([...refByKey.keys(), ...actualByKey.keys()])) {
    const fix = guessFix(refByKey.get(key), actualByKey.get(key));
    const group = fix.step ? bySteps : byReason;
    const groupKey = fix.step ?? fix.manual;

    group.set(groupKey, [...(group.get(groupKey) ?? []), key]);
  }

  // show a few object names per group, the full lines are printed above
  const sample = (keys) =>
    keys.slice(0, 3).join('; ') + (keys.length > 3 ? `; and ${keys.length - 3} more` : '');

  if (bySteps.size) {
    console.error(
      '\nmost likely these scripts were not run on this database, run them in this order:',
    );

    for (const [step, title] of FIX_STEPS) {
      const keys = bySteps.get(step);

      if (keys) console.error(`  ${title}: ${keys.length} objects (${sample(keys)})`);
    }

    console.error('then run this check again');
  }

  if (byReason.size) {
    console.error('\nnot fixed by running the scripts again:');

    for (const [reason, keys] of byReason) {
      console.error(`  ${keys.length} objects: ${reason} (${sample(keys)})`);
    }
  }
}

async function save() {
  console.log(`reading structure from ${describeTarget(CONTAINER_URL)}`);

  const lines = await takeSnapshot(CONTAINER_URL);

  writeFileSync(referenceFile, lines.join('\n') + '\n');

  console.log(`saved ${lines.length} lines to db/structure_snapshot.txt`);
  console.log(summarize(lines));
}

async function check(target) {
  if (!existsSync(referenceFile)) {
    console.error('db/structure_snapshot.txt not found, create it with: npm run db:snapshot:save');
    process.exit(1);
  }

  // compare either the local test container or the database from DATABASE_URL
  const isContainer = target !== 'db';
  const url = isContainer ? CONTAINER_URL : process.env.DATABASE_URL;
  const label = isContainer ? 'container' : 'database';

  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  // tolerate crlf: a windows checkout may convert the reference file
  const reference = readFileSync(referenceFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  console.log(`reading structure from ${describeTarget(url)}`);

  const actual = await takeSnapshot(url);

  const referenceSet = new Set(reference);
  const actualSet = new Set(actual);

  const missing = reference.filter((line) => !actualSet.has(line));
  const extra = actual.filter((line) => !referenceSet.has(line));

  if (!missing.length && !extra.length) {
    console.log(`structure matches the reference: ${actual.length} lines`);
    return;
  }

  console.error(`structure differs from the reference: ${missing.length + extra.length} lines`);

  for (const line of missing) console.error(`  only in reference: ${line}`);
  for (const line of extra) console.error(`  only in ${label}: ${line}`);

  if (isContainer) {
    console.error(
      '\nif the scripts were changed on purpose, refresh the reference: npm run db:snapshot:save',
    );
  } else {
    printSuggestions(missing, extra);
  }

  process.exit(1);
}

const [command, target] = process.argv.slice(2);

if (command === 'save' && target === undefined) await save();
else if (command === 'check' && (target === undefined || target === 'db')) await check(target);
else {
  console.error('usage: node db/structure_snapshot.mjs save | check | check db');
  process.exit(1);
}
