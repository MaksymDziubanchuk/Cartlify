-- show owner of objects in a chosen schema
-- use this to detect objects created under wrong role

-- set target schema here
\set schema_name 'cartlify'

-- show current connection context
select
  current_database() as db,
  current_user as current_user,
  current_schema() as current_schema;

-- tables / views / materialized views / sequences / foreign tables / partitioned tables
select
  n.nspname as schema,
  c.relname as name,
  case c.relkind
    when 'r' then 'table'
    when 'p' then 'partitioned_table'
    when 'v' then 'view'
    when 'm' then 'materialized_view'
    when 'S' then 'sequence'
    when 'f' then 'foreign_table'
    else 'relkind_' || c.relkind::text
  end as object_type,
  pg_get_userbyid(c.relowner) as owner
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = :'schema_name'
order by object_type, name;

-- functions (includes procedures, aggregates, window funcs; signature shown)
select
  n.nspname as schema,
  p.proname as name,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_get_function_result(p.oid) as result_type,
  case p.prokind
    when 'f' then 'function'
    when 'p' then 'procedure'
    when 'a' then 'aggregate'
    when 'w' then 'window'
    else 'prokind_' || p.prokind::text
  end as object_type,
  pg_get_userbyid(p.proowner) as owner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = :'schema_name'
order by name, identity_args;

-- types (includes enums, composites, domains)
select
  n.nspname as schema,
  t.typname as name,
  case t.typtype
    when 'e' then 'enum'
    when 'c' then 'composite'
    when 'd' then 'domain'
    when 'b' then 'base'
    when 'p' then 'pseudo'
    when 'r' then 'range'
    when 'm' then 'multirange'
    else 'typtype_' || t.typtype::text
  end as type_kind,
  pg_get_userbyid(t.typowner) as owner
from pg_type t
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = :'schema_name'
  and t.typtype <> 'p'
order by type_kind, name;

-- policies (policy itself has no owner field; it follows table owner)
select
  schemaname as schema,
  tablename as table_name,
  policyname as policy_name,
  (select pg_get_userbyid(c.relowner)
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = pg_policies.schemaname
     and c.relname = pg_policies.tablename
  ) as table_owner,
  permissive,
  roles,
  cmd
from pg_policies
where schemaname = :'schema_name'
order by table_name, policy_name;

-- triggers (trigger has no owner field; it follows table owner)
select
  n.nspname as schema,
  c.relname as table_name,
  t.tgname as trigger_name,
  pg_get_userbyid(c.relowner) as table_owner,
  case when t.tgenabled = 'O' then 'enabled' else 'disabled' end as status
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = :'schema_name'
  and not t.tgisinternal
order by table_name, trigger_name;
