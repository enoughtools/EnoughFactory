//! Postgres slices: database `ws_<name>` + role `ws_<name>` with a minted
//! password, granted on that database only. Admin connection via `sqlx`
//! using the service's admin secret from the helper chain.

use envmux_core::SliceKey;
use sqlx::Connection as _;
use sqlx::postgres::PgConnection;

use crate::{Health, ServiceError, SliceCredentials, WorkspaceRef, slice_ident};

pub struct Postgres {
    /// Admin URL reachable from the daemon (loopback-published admin port).
    pub admin_url: String,
    /// Hostname workspaces use on the namespace bridge (the service's DNS
    /// alias) — goes into the credentials file, not the admin connection.
    pub service_host: String,
    pub service_name: String,
}

/// Quote a SQL identifier defensively. Inputs come from validated workspace
/// names via [`slice_ident`], so this is belt-and-braces.
fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', ""))
}

/// Escape a string literal.
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

impl Postgres {
    async fn connect(&self) -> Result<PgConnection, ServiceError> {
        Ok(PgConnection::connect(&self.admin_url).await?)
    }

    pub async fn provision(&self, ws: &WorkspaceRef) -> Result<SliceCredentials, ServiceError> {
        let name = slice_ident(&ws.name);
        let password = envmux_secrets::mint_token();
        let mut conn = self.connect().await?;

        // Idempotent create: reuse tolerates a crashed earlier attempt.
        let role_exists: Option<(i32,)> =
            sqlx::query_as("SELECT 1 FROM pg_roles WHERE rolname = $1")
                .bind(&name)
                .fetch_optional(&mut conn)
                .await?;
        if role_exists.is_some() {
            sqlx::query(&format!(
                "ALTER ROLE {} WITH LOGIN PASSWORD {}",
                ident(&name),
                lit(&password)
            ))
            .execute(&mut conn)
            .await?;
        } else {
            sqlx::query(&format!(
                "CREATE ROLE {} WITH LOGIN PASSWORD {}",
                ident(&name),
                lit(&password)
            ))
            .execute(&mut conn)
            .await?;
        }

        let db_exists: Option<(i32,)> =
            sqlx::query_as("SELECT 1 FROM pg_database WHERE datname = $1")
                .bind(&name)
                .fetch_optional(&mut conn)
                .await?;
        if db_exists.is_none() {
            sqlx::query(&format!(
                "CREATE DATABASE {} OWNER {}",
                ident(&name),
                ident(&name)
            ))
            .execute(&mut conn)
            .await?;
        }
        sqlx::query(&format!(
            "GRANT ALL PRIVILEGES ON DATABASE {} TO {}",
            ident(&name),
            ident(&name)
        ))
        .execute(&mut conn)
        .await?;

        let slice_key =
            SliceKey::new(name.clone()).map_err(|_| ServiceError::BadKey(ws.name.to_string()))?;
        let url = format!(
            "postgres://{name}:{password}@{host}:5432/{name}",
            host = self.service_host
        );
        let mut files = std::collections::BTreeMap::new();
        files.insert("DATABASE_URL".to_owned(), url);
        files.insert("PGUSER".to_owned(), name.clone());
        files.insert("PGPASSWORD".to_owned(), password);
        files.insert("PGDATABASE".to_owned(), name);
        files.insert("PGHOST".to_owned(), self.service_host.clone());
        Ok(SliceCredentials {
            service: self.service_name.clone(),
            slice_key,
            files,
        })
    }

    pub async fn deprovision(&self, slice: &SliceKey) -> Result<(), ServiceError> {
        let mut conn = self.connect().await?;
        sqlx::query(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            ident(slice.as_str())
        ))
        .execute(&mut conn)
        .await?;
        sqlx::query(&format!("DROP ROLE IF EXISTS {}", ident(slice.as_str())))
            .execute(&mut conn)
            .await?;
        Ok(())
    }

    pub async fn audit(&self) -> Result<Vec<SliceKey>, ServiceError> {
        let mut conn = self.connect().await?;
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT datname FROM pg_database WHERE datname LIKE 'ws\\_%'")
                .fetch_all(&mut conn)
                .await?;
        Ok(rows
            .into_iter()
            .filter_map(|(name,)| SliceKey::new(name).ok())
            .collect())
    }

    pub async fn health(&self) -> Result<Health, ServiceError> {
        match self.connect().await {
            Ok(mut conn) => {
                let ok = sqlx::query("SELECT 1").execute(&mut conn).await.is_ok();
                Ok(if ok {
                    Health::Healthy
                } else {
                    Health::Unhealthy
                })
            }
            Err(_) => Ok(Health::Unhealthy),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_and_literals_are_defended() {
        assert_eq!(ident("ws_x"), "\"ws_x\"");
        assert_eq!(ident("bad\"name"), "\"badname\"");
        assert_eq!(lit("p'w"), "'p''w'");
    }
}
