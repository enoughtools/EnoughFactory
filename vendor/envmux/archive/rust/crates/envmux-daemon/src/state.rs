//! SQLite persistence: intent (`workspaces`, `slices`), condition
//! (`observations`, latest-only), captures, and the events audit ring.
//! WAL mode, foreign keys on, busy timeout 5 s.
//!
//! Queries use sqlx's runtime API rather than the compile-time macros so the
//! build needs no live database; the schema is exercised by the migration
//! tests below.

use std::path::Path;
use std::str::FromStr as _;

use envmux_core::{ReapStep, WorkspaceId, WorkspaceState};
use sqlx::Row as _;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};

pub type DbResult<T> = Result<T, sqlx::Error>;

#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

/// A workspace row (intent).
#[derive(Debug, Clone)]
pub struct WorkspaceRow {
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub state: WorkspaceState,
    pub branch_requested: String,
    pub config_hash: String,
    pub config_toml: String,
    pub created_at: String,
    pub death_date: Option<String>,
    pub lease_extended_at: Option<String>,
    pub reap_step: Option<ReapStep>,
    pub container_id: Option<String>,
}

/// An observation row (condition, latest-only).
#[derive(Debug, Clone, Default)]
pub struct ObservationRow {
    pub workspace_id: String,
    pub observed_at: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub dirty: bool,
    pub dirty_files: Option<i64>,
    pub truncated: bool,
    pub ahead: Option<i64>,
    pub behind: Option<i64>,
    pub flagged_state: Option<String>,
    pub tasks_json: String,
    pub last_attach_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CaptureRow {
    pub id: String,
    pub workspace_id: String,
    pub captured_at: String,
    pub branch: Option<String>,
    pub shadow_ref: String,
    pub commit_oid: String,
    pub torn: bool,
    pub flagged_state: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SliceRow {
    pub id: String,
    pub workspace_id: String,
    pub service: String,
    pub slice_key: String,
    pub state: String,
    pub created_at: String,
    pub deprovisioned_at: Option<String>,
    pub last_error: Option<String>,
}

fn now() -> String {
    jiff::Timestamp::now().to_string()
}

impl Db {
    /// Open (creating if needed) and migrate the database.
    pub async fn open(path: &Path) -> DbResult<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    #[cfg(test)]
    pub async fn open_memory() -> DbResult<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    // -- namespaces ---------------------------------------------------------

    pub async fn upsert_namespace(
        &self,
        name: &str,
        repo_remote: Option<&str>,
        repo_dir: &str,
        fetch_mode: &str,
    ) -> DbResult<()> {
        sqlx::query(
            "INSERT INTO namespaces (name, repo_remote, repo_dir, created_at, mirror_fetch_mode)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(name) DO UPDATE SET repo_remote = ?2, repo_dir = ?3,
                                               mirror_fetch_mode = ?5",
        )
        .bind(name)
        .bind(repo_remote)
        .bind(repo_dir)
        .bind(now())
        .bind(fetch_mode)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_namespaces(
        &self,
    ) -> DbResult<
        Vec<(
            String,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            String,
        )>,
    > {
        let rows = sqlx::query(
            "SELECT name, repo_remote, repo_dir, created_at, mirror_last_fetch, mirror_fetch_mode
             FROM namespaces ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5)))
            .collect())
    }

    pub async fn touch_mirror_fetch(&self, namespace: &str) -> DbResult<String> {
        let at = now();
        sqlx::query("UPDATE namespaces SET mirror_last_fetch = ?1 WHERE name = ?2")
            .bind(&at)
            .bind(namespace)
            .execute(&self.pool)
            .await?;
        Ok(at)
    }

    // -- workspaces ---------------------------------------------------------

    pub async fn insert_workspace(&self, row: &WorkspaceRow) -> DbResult<()> {
        // A reaped workspace is history, not a squatter. The schema's
        // UNIQUE(namespace, name) would otherwise make every named create
        // one-shot forever: the second `create --name x` after the first was
        // reaped dies on the constraint. Freeing the name lazily — a
        // tombstone suffix on the dead row, exactly when a new row wants the
        // name — keeps the constraint meaningful for the living without a
        // table rebuild.
        sqlx::query(
            "UPDATE workspaces SET name = name || '~' || substr(id, -6)
             WHERE namespace = ?1 AND name = ?2 AND state IN ('reaped', 'lost')",
        )
        .bind(&row.namespace)
        .bind(&row.name)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "INSERT INTO workspaces (id, namespace, name, state, branch_requested, config_hash,
                                     config_toml, created_at, death_date, lease_extended_at,
                                     reap_step, container_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )
        .bind(&row.id)
        .bind(&row.namespace)
        .bind(&row.name)
        .bind(row.state.as_str())
        .bind(&row.branch_requested)
        .bind(&row.config_hash)
        .bind(&row.config_toml)
        .bind(&row.created_at)
        .bind(&row.death_date)
        .bind(&row.lease_extended_at)
        .bind(row.reap_step.map(ReapStep::as_str))
        .bind(&row.container_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    fn row_to_workspace(r: &sqlx::sqlite::SqliteRow) -> WorkspaceRow {
        WorkspaceRow {
            id: r.get("id"),
            namespace: r.get("namespace"),
            name: r.get("name"),
            state: WorkspaceState::from_str(&r.get::<String, _>("state"))
                .unwrap_or(WorkspaceState::Lost),
            branch_requested: r.get("branch_requested"),
            config_hash: r.get("config_hash"),
            config_toml: r.get("config_toml"),
            created_at: r.get("created_at"),
            death_date: r.get("death_date"),
            lease_extended_at: r.get("lease_extended_at"),
            reap_step: r
                .get::<Option<String>, _>("reap_step")
                .and_then(|s| ReapStep::from_str(&s).ok()),
            container_id: r.get("container_id"),
        }
    }

    pub async fn get_workspace(&self, id: &str) -> DbResult<Option<WorkspaceRow>> {
        let row = sqlx::query("SELECT * FROM workspaces WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(Self::row_to_workspace))
    }

    pub async fn find_workspace(
        &self,
        namespace: &str,
        name: &str,
    ) -> DbResult<Option<WorkspaceRow>> {
        let row = sqlx::query("SELECT * FROM workspaces WHERE namespace = ?1 AND name = ?2")
            .bind(namespace)
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(Self::row_to_workspace))
    }

    pub async fn list_workspaces(&self, namespace: Option<&str>) -> DbResult<Vec<WorkspaceRow>> {
        let rows = match namespace {
            Some(ns) => {
                sqlx::query("SELECT * FROM workspaces WHERE namespace = ?1 ORDER BY created_at")
                    .bind(ns)
                    .fetch_all(&self.pool)
                    .await?
            }
            None => {
                sqlx::query("SELECT * FROM workspaces ORDER BY created_at")
                    .fetch_all(&self.pool)
                    .await?
            }
        };
        Ok(rows.iter().map(Self::row_to_workspace).collect())
    }

    /// Live = counted against max_workspaces and mirror-prune deferral.
    pub async fn count_live_workspaces(&self, namespace: &str) -> DbResult<i64> {
        let row = sqlx::query(
            "SELECT COUNT(*) FROM workspaces
             WHERE namespace = ?1 AND state IN ('provisioning','ready','degraded')",
        )
        .bind(namespace)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get(0))
    }

    /// Enforced transition: reads the current state, validates against the
    /// lifecycle table, writes the new one.
    pub async fn transition_workspace(
        &self,
        id: &str,
        to: WorkspaceState,
    ) -> DbResult<WorkspaceState> {
        let current = self
            .get_workspace(id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        envmux_core::state::try_transition(current.state, to)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        sqlx::query("UPDATE workspaces SET state = ?1 WHERE id = ?2")
            .bind(to.as_str())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(to)
    }

    pub async fn set_workspace_container(&self, id: &str, container_id: &str) -> DbResult<()> {
        sqlx::query("UPDATE workspaces SET container_id = ?1 WHERE id = ?2")
            .bind(container_id)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_reap_step(&self, id: &str, step: ReapStep) -> DbResult<()> {
        sqlx::query("UPDATE workspaces SET reap_step = ?1 WHERE id = ?2")
            .bind(step.as_str())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Set/extend the death date. `None` pins the workspace.
    pub async fn set_death_date(&self, id: &str, death_date: Option<&str>) -> DbResult<()> {
        sqlx::query("UPDATE workspaces SET death_date = ?1, lease_extended_at = ?2 WHERE id = ?3")
            .bind(death_date)
            .bind(now())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// The attach rule: now + extension if later than the current stamp.
    /// Pinned workspaces stay pinned. Returns the resulting death date.
    pub async fn extend_lease_on_attach(
        &self,
        id: &str,
        extension_secs: i64,
    ) -> DbResult<Option<String>> {
        let ws = self
            .get_workspace(id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        let Some(current) = ws.death_date else {
            return Ok(None); // pinned
        };
        let proposed = jiff::Timestamp::now()
            .checked_add(jiff::Span::new().seconds(extension_secs))
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
            .to_string();
        let new = if proposed > current {
            proposed
        } else {
            current
        };
        sqlx::query("UPDATE workspaces SET death_date = ?1, lease_extended_at = ?2 WHERE id = ?3")
            .bind(&new)
            .bind(now())
            .bind(id)
            .execute(&self.pool)
            .await?;
        sqlx::query("UPDATE observations SET last_attach_at = ?1 WHERE workspace_id = ?2")
            .bind(now())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(Some(new))
    }

    /// Reaper sweep: live workspaces past their stamped date. Nothing is
    /// computed from elapsed time — only the stamp is compared.
    pub async fn workspaces_past_death(&self) -> DbResult<Vec<WorkspaceRow>> {
        let rows = sqlx::query(
            "SELECT * FROM workspaces
             WHERE state IN ('provisioning','ready','degraded')
               AND death_date IS NOT NULL AND death_date < ?1",
        )
        .bind(now())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(Self::row_to_workspace).collect())
    }

    /// Workspaces stuck mid-reap (daemon crashed); resumed at boot.
    pub async fn workspaces_reaping(&self) -> DbResult<Vec<WorkspaceRow>> {
        let rows = sqlx::query("SELECT * FROM workspaces WHERE state = 'reaping'")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.iter().map(Self::row_to_workspace).collect())
    }

    // -- observations -------------------------------------------------------

    pub async fn upsert_observation(&self, o: &ObservationRow) -> DbResult<()> {
        sqlx::query(
            "INSERT INTO observations (workspace_id, observed_at, branch, head, dirty,
                                       dirty_files, truncated, ahead, behind, flagged_state,
                                       tasks_json, last_attach_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                     COALESCE(?12, (SELECT last_attach_at FROM observations WHERE workspace_id = ?1)))
             ON CONFLICT(workspace_id) DO UPDATE SET
                observed_at = ?2, branch = ?3, head = ?4, dirty = ?5, dirty_files = ?6,
                truncated = ?7, ahead = ?8, behind = ?9, flagged_state = ?10, tasks_json = ?11,
                last_attach_at = COALESCE(?12, observations.last_attach_at)",
        )
        .bind(&o.workspace_id)
        .bind(&o.observed_at)
        .bind(&o.branch)
        .bind(&o.head)
        .bind(o.dirty)
        .bind(o.dirty_files)
        .bind(o.truncated)
        .bind(o.ahead)
        .bind(o.behind)
        .bind(&o.flagged_state)
        .bind(&o.tasks_json)
        .bind(&o.last_attach_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_observation(&self, workspace_id: &str) -> DbResult<Option<ObservationRow>> {
        let row = sqlx::query("SELECT * FROM observations WHERE workspace_id = ?1")
            .bind(workspace_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| ObservationRow {
            workspace_id: r.get("workspace_id"),
            observed_at: r.get("observed_at"),
            branch: r.get("branch"),
            head: r.get("head"),
            dirty: r.get("dirty"),
            dirty_files: r.get("dirty_files"),
            truncated: r.get("truncated"),
            ahead: r.get("ahead"),
            behind: r.get("behind"),
            flagged_state: r.get("flagged_state"),
            tasks_json: r.get("tasks_json"),
            last_attach_at: r.get("last_attach_at"),
        }))
    }

    // -- captures -----------------------------------------------------------

    pub async fn insert_capture(&self, c: &CaptureRow) -> DbResult<()> {
        sqlx::query(
            "INSERT INTO captures (id, workspace_id, captured_at, branch, shadow_ref,
                                   commit_oid, torn, flagged_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(&c.id)
        .bind(&c.workspace_id)
        .bind(&c.captured_at)
        .bind(&c.branch)
        .bind(&c.shadow_ref)
        .bind(&c.commit_oid)
        .bind(c.torn)
        .bind(&c.flagged_state)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_captures(
        &self,
        workspace_id: Option<&str>,
        branch: Option<&str>,
    ) -> DbResult<Vec<CaptureRow>> {
        let base = "SELECT * FROM captures".to_owned();
        let rows = match (workspace_id, branch) {
            (Some(ws), _) => {
                sqlx::query(&format!(
                    "{base} WHERE workspace_id = ?1 ORDER BY captured_at DESC"
                ))
                .bind(ws)
                .fetch_all(&self.pool)
                .await?
            }
            (None, Some(b)) => {
                sqlx::query(&format!(
                    "{base} WHERE branch = ?1 ORDER BY captured_at DESC"
                ))
                .bind(b)
                .fetch_all(&self.pool)
                .await?
            }
            (None, None) => {
                sqlx::query(&format!("{base} ORDER BY captured_at DESC"))
                    .fetch_all(&self.pool)
                    .await?
            }
        };
        Ok(rows
            .into_iter()
            .map(|r| CaptureRow {
                id: r.get("id"),
                workspace_id: r.get("workspace_id"),
                captured_at: r.get("captured_at"),
                branch: r.get("branch"),
                shadow_ref: r.get("shadow_ref"),
                commit_oid: r.get("commit_oid"),
                torn: r.get("torn"),
                flagged_state: r.get("flagged_state"),
            })
            .collect())
    }

    pub async fn get_capture(&self, id: &str) -> DbResult<Option<CaptureRow>> {
        let row = sqlx::query("SELECT * FROM captures WHERE id = ?1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| CaptureRow {
            id: r.get("id"),
            workspace_id: r.get("workspace_id"),
            captured_at: r.get("captured_at"),
            branch: r.get("branch"),
            shadow_ref: r.get("shadow_ref"),
            commit_oid: r.get("commit_oid"),
            torn: r.get("torn"),
            flagged_state: r.get("flagged_state"),
        }))
    }

    // -- slices -------------------------------------------------------------

    pub async fn insert_slice(&self, s: &SliceRow) -> DbResult<()> {
        sqlx::query(
            "INSERT INTO slices (id, workspace_id, service, slice_key, state, created_at,
                                 deprovisioned_at, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(&s.id)
        .bind(&s.workspace_id)
        .bind(&s.service)
        .bind(&s.slice_key)
        .bind(&s.state)
        .bind(&s.created_at)
        .bind(&s.deprovisioned_at)
        .bind(&s.last_error)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_slice_state(
        &self,
        id: &str,
        state: &str,
        last_error: Option<&str>,
    ) -> DbResult<()> {
        sqlx::query(
            "UPDATE slices SET state = ?1, last_error = ?2,
                    deprovisioned_at = CASE WHEN ?1 = 'deprovisioned' THEN ?3 ELSE deprovisioned_at END
             WHERE id = ?4",
        )
        .bind(state)
        .bind(last_error)
        .bind(now())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_slices(&self, workspace_id: Option<&str>) -> DbResult<Vec<SliceRow>> {
        let rows = match workspace_id {
            Some(ws) => {
                sqlx::query("SELECT * FROM slices WHERE workspace_id = ?1")
                    .bind(ws)
                    .fetch_all(&self.pool)
                    .await?
            }
            None => {
                sqlx::query("SELECT * FROM slices")
                    .fetch_all(&self.pool)
                    .await?
            }
        };
        Ok(rows
            .into_iter()
            .map(|r| SliceRow {
                id: r.get("id"),
                workspace_id: r.get("workspace_id"),
                service: r.get("service"),
                slice_key: r.get("slice_key"),
                state: r.get("state"),
                created_at: r.get("created_at"),
                deprovisioned_at: r.get("deprovisioned_at"),
                last_error: r.get("last_error"),
            })
            .collect())
    }

    // -- events -------------------------------------------------------------

    pub async fn record_event(
        &self,
        level: &str,
        namespace: Option<&str>,
        workspace: Option<&str>,
        component: &str,
        message: &str,
    ) -> DbResult<()> {
        sqlx::query(
            "INSERT INTO events (at, level, namespace, workspace, component, message)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(now())
        .bind(level)
        .bind(namespace)
        .bind(workspace)
        .bind(component)
        .bind(message)
        .execute(&self.pool)
        .await?;
        // Ring-buffer: keep the newest 10k rows.
        sqlx::query(
            "DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0) - 10000 FROM events)",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_events(
        &self,
        since_id: i64,
        limit: i64,
    ) -> DbResult<
        Vec<(
            i64,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            String,
        )>,
    > {
        let rows = sqlx::query(
            "SELECT id, at, level, namespace, workspace, component, message
             FROM events WHERE id > ?1 ORDER BY id LIMIT ?2",
        )
        .bind(since_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                (
                    r.get(0),
                    r.get(1),
                    r.get(2),
                    r.get(3),
                    r.get(4),
                    r.get(5),
                    r.get(6),
                )
            })
            .collect())
    }
}

/// Helper to make a fresh workspace row at creation time.
#[must_use]
pub fn new_workspace_row(
    namespace: &str,
    name: &str,
    branch: &str,
    config_hash: &str,
    config_toml: &str,
    initial_lease_secs: i64,
) -> WorkspaceRow {
    let death = jiff::Timestamp::now()
        .checked_add(jiff::Span::new().seconds(initial_lease_secs))
        .expect("lease within range")
        .to_string();
    WorkspaceRow {
        id: WorkspaceId::generate().to_string(),
        namespace: namespace.to_owned(),
        name: name.to_owned(),
        state: WorkspaceState::Provisioning,
        branch_requested: branch.to_owned(),
        config_hash: config_hash.to_owned(),
        config_toml: config_toml.to_owned(),
        created_at: now(),
        death_date: Some(death),
        lease_extended_at: None,
        reap_step: None,
        container_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db_with_ws() -> (Db, WorkspaceRow) {
        let db = Db::open_memory().await.unwrap();
        db.upsert_namespace(
            "ns",
            Some("https://example.com/r.git"),
            "/tmp/repo",
            "periodic",
        )
        .await
        .unwrap();
        let row = new_workspace_row(
            "ns",
            "wobbly-otter",
            "main",
            &"a".repeat(64),
            "[image]\n",
            7 * 86400,
        );
        db.insert_workspace(&row).await.unwrap();
        (db, row)
    }

    #[tokio::test]
    async fn a_reaped_workspace_frees_its_name() {
        let (db, row) = db_with_ws().await;
        // Walk the row to Reaped through the legal transitions.
        db.transition_workspace(&row.id, WorkspaceState::Reaping)
            .await
            .unwrap();
        db.transition_workspace(&row.id, WorkspaceState::Reaped)
            .await
            .unwrap();

        // The same name must be creatable again — this is the second
        // `create --name x` after the first was reaped, which used to die
        // on UNIQUE(namespace, name).
        let again = new_workspace_row(
            "ns",
            "wobbly-otter",
            "main",
            &"b".repeat(64),
            "[image]\n",
            7 * 86400,
        );
        db.insert_workspace(&again).await.expect("name is free");

        // The dead row still exists for history, under a tombstone name.
        let old = db.get_workspace(&row.id).await.unwrap().unwrap();
        assert_ne!(old.name, "wobbly-otter");
        assert!(old.name.starts_with("wobbly-otter~"), "{}", old.name);
        // And a LIVE row's name is still defended.
        let clash = new_workspace_row(
            "ns",
            "wobbly-otter",
            "main",
            &"c".repeat(64),
            "[image]\n",
            7 * 86400,
        );
        assert!(db.insert_workspace(&clash).await.is_err());
    }

    #[tokio::test]
    async fn migrations_apply_and_workspace_round_trips() {
        let (db, row) = db_with_ws().await;
        let got = db.get_workspace(&row.id).await.unwrap().unwrap();
        assert_eq!(got.name, "wobbly-otter");
        assert_eq!(got.state, WorkspaceState::Provisioning);
        assert!(got.death_date.is_some());
        assert_eq!(db.count_live_workspaces("ns").await.unwrap(), 1);
    }

    #[tokio::test]
    async fn transitions_are_enforced() {
        let (db, row) = db_with_ws().await;
        db.transition_workspace(&row.id, WorkspaceState::Ready)
            .await
            .unwrap();
        db.transition_workspace(&row.id, WorkspaceState::Reaping)
            .await
            .unwrap();
        // Reaping cannot go back to Ready.
        assert!(
            db.transition_workspace(&row.id, WorkspaceState::Ready)
                .await
                .is_err()
        );
        db.transition_workspace(&row.id, WorkspaceState::Reaped)
            .await
            .unwrap();
        assert_eq!(db.count_live_workspaces("ns").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn attach_extends_lease_only_forward() {
        let (db, row) = db_with_ws().await;
        // 7-day stamp; +24h attach must NOT shorten it.
        let before = db
            .get_workspace(&row.id)
            .await
            .unwrap()
            .unwrap()
            .death_date
            .unwrap();
        let after = db
            .extend_lease_on_attach(&row.id, 86400)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before, after);

        // Shorten to 1h, then attach pushes it to ~24h.
        let soon = jiff::Timestamp::now()
            .checked_add(jiff::Span::new().seconds(3600))
            .unwrap()
            .to_string();
        db.set_death_date(&row.id, Some(&soon)).await.unwrap();
        let extended = db
            .extend_lease_on_attach(&row.id, 86400)
            .await
            .unwrap()
            .unwrap();
        assert!(extended > soon);

        // Pinned workspaces stay pinned.
        db.set_death_date(&row.id, None).await.unwrap();
        assert_eq!(
            db.extend_lease_on_attach(&row.id, 86400).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn reaper_sweep_selects_only_past_stamp() {
        let (db, row) = db_with_ws().await;
        assert!(db.workspaces_past_death().await.unwrap().is_empty());
        let past = jiff::Timestamp::now()
            .checked_sub(jiff::Span::new().seconds(60))
            .unwrap()
            .to_string();
        db.set_death_date(&row.id, Some(&past)).await.unwrap();
        let victims = db.workspaces_past_death().await.unwrap();
        assert_eq!(victims.len(), 1);
        assert_eq!(victims[0].id, row.id);
    }

    #[tokio::test]
    async fn observations_are_latest_only() {
        let (db, row) = db_with_ws().await;
        let mut o = ObservationRow {
            workspace_id: row.id.clone(),
            observed_at: "2026-01-01T00:00:00Z".into(),
            branch: Some("main".into()),
            dirty: true,
            dirty_files: Some(3),
            tasks_json: "[]".into(),
            ..Default::default()
        };
        db.upsert_observation(&o).await.unwrap();
        o.observed_at = "2026-01-02T00:00:00Z".into();
        o.dirty_files = Some(5);
        db.upsert_observation(&o).await.unwrap();
        let got = db.get_observation(&row.id).await.unwrap().unwrap();
        assert_eq!(got.dirty_files, Some(5));
        assert_eq!(got.observed_at, "2026-01-02T00:00:00Z");
    }

    #[tokio::test]
    async fn events_ring() {
        let (db, _row) = db_with_ws().await;
        db.record_event("info", Some("ns"), None, "test", "hello")
            .await
            .unwrap();
        let events = db.list_events(0, 10).await.unwrap();
        assert_eq!(events.len(), 1);
    }
}
