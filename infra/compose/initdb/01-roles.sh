#!/bin/sh
# Runs once, on first start of an empty data volume (docker-entrypoint-initdb.d).
# aep_owner owns the schema and runs migrations; aep_app is the least-privilege runtime role.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$AEP_OWNER_DB_PASSWORD" -v app_pw="$AEP_APP_DB_PASSWORD" <<'SQL'
create role aep_owner login password :'owner_pw' nosuperuser nobypassrls;
create role aep_app login password :'app_pw' nosuperuser nobypassrls;
revoke create on schema public from public;
grant create on schema public to aep_owner;
SQL
