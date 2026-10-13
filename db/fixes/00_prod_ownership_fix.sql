-- one-time script: transfer ownership of non-extension objects in schema cartlify to cartlify_owner
-- run as postgres/superuser or as the current owner of the objects you want to change
begin;

set
  local lock_timeout = '10s';

set
  local statement_timeout = '5min';

-- ensure schema exists and is owned by cartlify_owner
do $do$
begin
  if not exists (
    select 1 from information_schema.schemata where schema_name = 'cartlify'
  ) then
    execute 'create schema cartlify authorization cartlify_owner';
  else
    execute 'alter schema cartlify owner to cartlify_owner';
  end if;
end
$do$;

-- transfer ownership of objects inside schema cartlify
do $do$
declare
  v_schema text := 'cartlify';
  v_owner  text := 'cartlify_owner';
  r record;
begin
  -- tables, partitioned tables, foreign tables
  for r in
    select n.nspname as schema_name, c.relname as obj_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = v_schema
      and c.relkind in ('r','p','f')
      and not exists (
        select 1
        from pg_depend d
        where d.classid = 'pg_class'::regclass
          and d.objid = c.oid
          and d.refclassid = 'pg_extension'::regclass
      )
  loop
    begin
      execute format('alter table %I.%I owner to %I', r.schema_name, r.obj_name, v_owner);
    exception when others then
      raise notice 'skip table %.%: %', r.schema_name, r.obj_name, sqlerrm;
    end;
  end loop;

  -- sequences
  for r in
    select n.nspname as schema_name, c.relname as obj_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = v_schema
      and c.relkind = 'S'
      and not exists (
        select 1
        from pg_depend d
        where d.classid = 'pg_class'::regclass
          and d.objid = c.oid
          and d.refclassid = 'pg_extension'::regclass
      )
  loop
    begin
      execute format('alter sequence %I.%I owner to %I', r.schema_name, r.obj_name, v_owner);
    exception when others then
      raise notice 'skip sequence %.%: %', r.schema_name, r.obj_name, sqlerrm;
    end;
  end loop;

  -- views and materialized views
  for r in
    select n.nspname as schema_name, c.relname as obj_name, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = v_schema
      and c.relkind in ('v','m')
      and not exists (
        select 1
        from pg_depend d
        where d.classid = 'pg_class'::regclass
          and d.objid = c.oid
          and d.refclassid = 'pg_extension'::regclass
      )
  loop
    begin
      if r.relkind = 'v' then
        execute format('alter view %I.%I owner to %I', r.schema_name, r.obj_name, v_owner);
      else
        execute format('alter materialized view %I.%I owner to %I', r.schema_name, r.obj_name, v_owner);
      end if;
    exception when others then
      raise notice 'skip view/matview %.%: %', r.schema_name, r.obj_name, sqlerrm;
    end;
  end loop;

  -- functions
  for r in
    select
      n.nspname as schema_name,
      p.proname as obj_name,
      pg_get_function_identity_arguments(p.oid) as args,
      p.oid as oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = v_schema
      and not exists (
        select 1
        from pg_depend d
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.refclassid = 'pg_extension'::regclass
      )
  loop
    begin
      execute format(
        'alter function %I.%I(%s) owner to %I',
        r.schema_name, r.obj_name, r.args, v_owner
      );
    exception when others then
      raise notice 'skip function %.%(%) : %', r.schema_name, r.obj_name, r.args, sqlerrm;
    end;
  end loop;

  -- types
  -- enums, domains, composite types
  for r in
    select n.nspname as schema_name, t.typname as obj_name, t.oid as oid, t.typtype
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = v_schema
      and t.typtype in ('e','d','c')
      and not exists (
        select 1
        from pg_depend d
        where d.classid = 'pg_type'::regclass
          and d.objid = t.oid
          and d.refclassid = 'pg_extension'::regclass
      )
  loop
    begin
      execute format('alter type %I.%I owner to %I', r.schema_name, r.obj_name, v_owner);
    exception when others then
      raise notice 'skip type %.%: %', r.schema_name, r.obj_name, sqlerrm;
    end;
  end loop;
end
$do$;

commit;