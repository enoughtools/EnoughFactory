//! MinIO slices: bucket `ws-<name>` plus a service account scoped by policy
//! to that bucket. Admin operations run `mc` *inside the service container*
//! via Docker exec — avoiding unstable admin-API crates; `mc` ships in the
//! service image envmux pins.

use envmux_core::SliceKey;
use envmux_docker::DockerHandle;

use crate::{Health, ServiceError, SliceCredentials, WorkspaceRef, slice_bucket};

pub struct Minio {
    pub docker: DockerHandle,
    /// The service container `mc` runs in.
    pub container: String,
    pub admin_user: String,
    pub admin_password: String,
    pub service_host: String,
    pub service_name: String,
}

/// Bucket-scoped read-write policy document.
#[must_use]
pub fn bucket_policy_json(bucket: &str) -> String {
    serde_json::json!({
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": ["s3:*"],
                "Resource": [
                    format!("arn:aws:s3:::{bucket}"),
                    format!("arn:aws:s3:::{bucket}/*")
                ]
            }
        ]
    })
    .to_string()
}

impl Minio {
    /// Run a shell line inside the service container with the local alias
    /// configured. The alias set is idempotent and cheap.
    async fn mc(&self, script: &str) -> Result<String, ServiceError> {
        let full = format!(
            "mc alias set local http://127.0.0.1:9000 \"$ENVMUX_MC_USER\" \"$ENVMUX_MC_PASS\" >/dev/null && {script}"
        );
        let out = self
            .docker
            .run_exec(
                &self.container,
                vec!["sh".into(), "-c".into(), full],
                None,
                None,
                vec![
                    format!("ENVMUX_MC_USER={}", self.admin_user),
                    format!("ENVMUX_MC_PASS={}", self.admin_password),
                ],
                None,
            )
            .await?;
        if !out.success() {
            return Err(ServiceError::Minio(format!(
                "mc exited {}: {}",
                out.exit_code,
                out.stderr.trim()
            )));
        }
        Ok(out.stdout)
    }

    pub async fn provision(&self, ws: &WorkspaceRef) -> Result<SliceCredentials, ServiceError> {
        let bucket = slice_bucket(&ws.name);
        let access_key = format!("{bucket}-svc");
        let secret_key = envmux_secrets::mint_token();
        let policy = bucket_policy_json(&bucket);

        // mb --ignore-existing and forced policy/user re-create keep this
        // idempotent across crashed earlier attempts.
        self.mc(&format!("mc mb --ignore-existing local/{bucket}"))
            .await?;
        self.mc(&format!(
            "printf '%s' '{policy}' > /tmp/{bucket}-policy.json && \
             mc admin policy create local {bucket}-policy /tmp/{bucket}-policy.json && \
             rm -f /tmp/{bucket}-policy.json",
            policy = policy.replace('\'', "'\\''"),
        ))
        .await?;
        self.mc(&format!(
            "mc admin user add local {access_key} {secret_key} && \
             mc admin policy attach local {bucket}-policy --user {access_key} || true"
        ))
        .await?;

        let slice_key =
            SliceKey::new(bucket.clone()).map_err(|_| ServiceError::BadKey(ws.name.to_string()))?;
        let mut files = std::collections::BTreeMap::new();
        files.insert(
            "S3_ENDPOINT".to_owned(),
            format!("http://{}:9000", self.service_host),
        );
        files.insert("S3_BUCKET".to_owned(), bucket);
        files.insert("AWS_ACCESS_KEY_ID".to_owned(), access_key);
        files.insert("AWS_SECRET_ACCESS_KEY".to_owned(), secret_key);
        Ok(SliceCredentials {
            service: self.service_name.clone(),
            slice_key,
            files,
        })
    }

    pub async fn deprovision(&self, slice: &SliceKey) -> Result<(), ServiceError> {
        let bucket = slice.as_str();
        // Each step tolerates already-gone.
        self.mc(&format!(
            "mc admin user remove local {bucket}-svc || true; \
             mc admin policy detach local {bucket}-policy --user {bucket}-svc 2>/dev/null || true; \
             mc admin policy rm local {bucket}-policy || true; \
             mc rb --force local/{bucket} || true"
        ))
        .await?;
        Ok(())
    }

    pub async fn audit(&self) -> Result<Vec<SliceKey>, ServiceError> {
        let out = self.mc("mc ls local --json").await?;
        let mut keys = Vec::new();
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(key) = v.get("key").and_then(|k| k.as_str()) {
                    let name = key.trim_end_matches('/');
                    if name.starts_with("ws-") {
                        if let Ok(k) = SliceKey::new(name.to_owned()) {
                            keys.push(k);
                        }
                    }
                }
            }
        }
        Ok(keys)
    }

    pub async fn health(&self) -> Result<Health, ServiceError> {
        match self.mc("mc ready local").await {
            Ok(_) => Ok(Health::Healthy),
            Err(_) => Ok(Health::Unhealthy),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_scopes_to_one_bucket() {
        let p = bucket_policy_json("ws-otter");
        let v: serde_json::Value = serde_json::from_str(&p).unwrap();
        let resources = v["Statement"][0]["Resource"].as_array().unwrap();
        assert_eq!(resources.len(), 2);
        assert!(resources[0].as_str().unwrap().ends_with(":ws-otter"));
        assert!(resources[1].as_str().unwrap().ends_with(":ws-otter/*"));
    }
}
