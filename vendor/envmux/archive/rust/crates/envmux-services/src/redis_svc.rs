//! Redis slices: ACL user `ws_<name>` restricted to the key pattern
//! `ws_<name>:*`, with a minted password.

use envmux_core::SliceKey;

use crate::{Health, ServiceError, SliceCredentials, WorkspaceRef, slice_ident};

pub struct Redis {
    /// Admin URL reachable from the daemon.
    pub admin_url: String,
    pub service_host: String,
    pub service_name: String,
}

impl Redis {
    async fn connect(&self) -> Result<redis::aio::MultiplexedConnection, ServiceError> {
        let client = redis::Client::open(self.admin_url.as_str())?;
        Ok(client.get_multiplexed_async_connection().await?)
    }

    pub async fn provision(&self, ws: &WorkspaceRef) -> Result<SliceCredentials, ServiceError> {
        let name = slice_ident(&ws.name);
        let password = envmux_secrets::mint_token();
        let mut conn = self.connect().await?;

        // ACL SETUSER is a full replace, which makes provisioning idempotent.
        redis::cmd("ACL")
            .arg("SETUSER")
            .arg(&name)
            .arg("on")
            .arg(format!(">{password}"))
            .arg(format!("~{name}:*"))
            .arg("+@all")
            .arg("-@admin")
            .query_async::<()>(&mut conn)
            .await?;

        let slice_key =
            SliceKey::new(name.clone()).map_err(|_| ServiceError::BadKey(ws.name.to_string()))?;
        let url = format!(
            "redis://{name}:{password}@{host}:6379",
            host = self.service_host
        );
        let mut files = std::collections::BTreeMap::new();
        files.insert("REDIS_URL".to_owned(), url);
        files.insert("REDIS_USER".to_owned(), name.clone());
        files.insert("REDIS_PASSWORD".to_owned(), password);
        files.insert("REDIS_KEY_PREFIX".to_owned(), format!("{name}:"));
        Ok(SliceCredentials {
            service: self.service_name.clone(),
            slice_key,
            files,
        })
    }

    pub async fn deprovision(&self, slice: &SliceKey) -> Result<(), ServiceError> {
        let mut conn = self.connect().await?;
        // DELUSER returns the number deleted; 0 (already gone) is fine.
        redis::cmd("ACL")
            .arg("DELUSER")
            .arg(slice.as_str())
            .query_async::<i64>(&mut conn)
            .await?;
        Ok(())
    }

    pub async fn audit(&self) -> Result<Vec<SliceKey>, ServiceError> {
        let mut conn = self.connect().await?;
        let users: Vec<String> = redis::cmd("ACL")
            .arg("USERS")
            .query_async(&mut conn)
            .await?;
        Ok(users
            .into_iter()
            .filter(|u| u.starts_with("ws_"))
            .filter_map(|u| SliceKey::new(u).ok())
            .collect())
    }

    pub async fn health(&self) -> Result<Health, ServiceError> {
        match self.connect().await {
            Ok(mut conn) => {
                let pong: Result<String, _> = redis::cmd("PING").query_async(&mut conn).await;
                Ok(if pong.is_ok() {
                    Health::Healthy
                } else {
                    Health::Unhealthy
                })
            }
            Err(_) => Ok(Health::Unhealthy),
        }
    }
}
