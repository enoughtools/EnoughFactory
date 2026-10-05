-- envmux daemon state, schema v1.
-- Intent lives here (workspaces, slices); Docker labels hold reality;
-- observations hold current condition, latest-only.

CREATE TABLE namespaces (
    name              TEXT PRIMARY KEY,
    repo_remote       TEXT,
    created_at        TEXT NOT NULL,
    mirror_last_fetch TEXT,
    mirror_fetch_mode TEXT NOT NULL DEFAULT 'periodic'
);

CREATE TABLE workspaces (
    id                TEXT PRIMARY KEY,
    namespace         TEXT NOT NULL REFERENCES namespaces(name),
    name              TEXT NOT NULL,
    state             TEXT NOT NULL,
    branch_requested  TEXT NOT NULL,
    config_hash       TEXT NOT NULL,
    config_toml       TEXT NOT NULL,          -- full resolved TOML frozen at launch
    created_at        TEXT NOT NULL,
    death_date        TEXT,                   -- NULL = pinned
    lease_extended_at TEXT,
    reap_step         TEXT,
    container_id      TEXT,
    UNIQUE (namespace, name)
);

CREATE INDEX idx_workspaces_state ON workspaces(state);
CREATE INDEX idx_workspaces_death ON workspaces(death_date);

-- Latest-only by design; history is not kept.
CREATE TABLE observations (
    workspace_id   TEXT PRIMARY KEY REFERENCES workspaces(id),
    observed_at    TEXT NOT NULL,
    branch         TEXT,
    head           TEXT,
    dirty          INTEGER NOT NULL DEFAULT 0,
    dirty_files    INTEGER,
    truncated      INTEGER NOT NULL DEFAULT 0,
    ahead          INTEGER,
    behind         INTEGER,
    flagged_state  TEXT,
    tasks_json     TEXT NOT NULL DEFAULT '[]',
    last_attach_at TEXT
);

CREATE TABLE captures (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
    captured_at   TEXT NOT NULL,
    branch        TEXT,
    shadow_ref    TEXT NOT NULL,
    commit_oid    TEXT NOT NULL,
    torn          INTEGER NOT NULL DEFAULT 0,
    flagged_state TEXT
);

CREATE INDEX idx_captures_ws ON captures(workspace_id, captured_at);

CREATE TABLE slices (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
    service          TEXT NOT NULL,
    slice_key        TEXT NOT NULL,
    state            TEXT NOT NULL,            -- provisioned|deprovisioned|failed
    created_at       TEXT NOT NULL,
    deprovisioned_at TEXT,
    last_error       TEXT
);

CREATE INDEX idx_slices_ws ON slices(workspace_id);

CREATE TABLE certificates (
    serial    TEXT PRIMARY KEY,
    kind      TEXT NOT NULL,                   -- ca|server|client
    subject   TEXT NOT NULL,
    not_after TEXT NOT NULL,
    revoked   INTEGER NOT NULL DEFAULT 0
);

-- Ring-buffered audit trail (pruned by row count, not the tracing log).
CREATE TABLE events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    level     TEXT NOT NULL,
    namespace TEXT,
    workspace TEXT,
    component TEXT NOT NULL,
    message   TEXT NOT NULL
);
