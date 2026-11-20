#!/bin/sh
# Runs once, when the PostgreSQL data directory is first created.
# Creates one database and one unprivileged role each for Velydock and Keycloak.
#
# The Velydock role is deliberately neither superuser nor BYPASSRLS: tenant isolation is enforced
# by row-level security, which superusers would bypass.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
     -v velydock_pw="$VELYDOCK_DB_PASSWORD" -v keycloak_pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE velydock LOGIN PASSWORD :'velydock_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE keycloak LOGIN PASSWORD :'keycloak_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE velydock OWNER velydock;
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE velydock FROM PUBLIC;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL
