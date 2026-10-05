//! Container-side git operations as versioned, embedded shell scripts — no
//! ad-hoc string building — plus parsers for their structured `key=value`
//! output. The daemon runs these via Docker exec with parameters passed as
//! environment variables; nothing here interpolates values into script text.
//!
//! Every script emits one `key=value` per line on stdout; parsers ignore
//! unknown keys so scripts can grow additively.

use std::collections::BTreeMap;

use crate::host::GitError;

/// Script schema version; bumped when output keys change incompatibly.
pub const SCRIPT_VERSION: u32 = 1;

/// Parameters for the workspace clone script (passed as env).
#[derive(Debug, Clone)]
pub struct CloneParams {
    /// `shared` (git clone -s against the mirror mount) or `full`.
    pub strategy: &'static str,
    pub mirror_path: String,
    pub branch: String,
    pub workdir: String,
    /// The real remote URL `origin` is remapped to, so `git push` from inside
    /// the workspace goes upstream.
    pub remote_url: String,
}

impl CloneParams {
    #[must_use]
    pub fn to_env(&self) -> Vec<String> {
        vec![
            format!("ENVMUX_STRATEGY={}", self.strategy),
            format!("ENVMUX_MIRROR={}", self.mirror_path),
            format!("ENVMUX_BRANCH={}", self.branch),
            format!("ENVMUX_WORKDIR={}", self.workdir),
            format!("ENVMUX_REMOTE={}", self.remote_url),
        ]
    }
}

/// §8.2 — workspace clone with shared objects via alternates, then remap
/// `origin` upstream. Full-clone opt-out takes the same path minus `-s`.
pub const CLONE_SCRIPT: &str = r#"
set -eu
if [ "$ENVMUX_STRATEGY" = "shared" ]; then
    git clone -s -b "$ENVMUX_BRANCH" "$ENVMUX_MIRROR" "$ENVMUX_WORKDIR"
else
    git clone -b "$ENVMUX_BRANCH" "$ENVMUX_MIRROR" "$ENVMUX_WORKDIR"
fi
cd "$ENVMUX_WORKDIR"
git remote set-url origin "$ENVMUX_REMOTE"
echo "cloned=1"
echo "head=$(git rev-parse HEAD)"
"#;

/// §8.3 — scheduled shadow capture with torn detection, against a separate
/// index; the workspace's own HEAD, index, and branch are untouched.
///
/// Env: `ENVMUX_WORKDIR`, `ENVMUX_SHADOW` (URL or path of the shadow repo),
/// `ENVMUX_WS` (workspace name), `ENVMUX_TS` (RFC 3339), `ENVMUX_TS_SAFE`
/// (ref-safe timestamp), `ENVMUX_PREV` (previous shadow tip oid or empty).
pub const CAPTURE_SCRIPT: &str = r#"
set -eu
cd "$ENVMUX_WORKDIR"
export GIT_AUTHOR_NAME=envmux GIT_AUTHOR_EMAIL=envmux@local
export GIT_COMMITTER_NAME=envmux GIT_COMMITTER_EMAIL=envmux@local

flagged=""
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then flagged="rebase"; fi
if [ -f .git/MERGE_HEAD ]; then flagged="merge"; fi
if [ -n "$(git --no-optional-locks ls-files -u 2>/dev/null | head -n1)" ]; then flagged="conflict"; fi

listing() {
    find . -name .git -prune -o -type f -print 2>/dev/null | sort | while IFS= read -r f; do
        # shellcheck disable=SC2012
        ls -ln -- "$f" 2>/dev/null | awk '{print $5, $NF}'
    done | git hash-object --stdin
}

attempt() {
    PRE=$(listing)
    # -u: git must not find an existing (empty) file at the index path.
    IDX=$(mktemp -u)
    export GIT_INDEX_FILE="$IDX"
    git --no-optional-locks add -A . >/dev/null 2>&1 || true
    TREE=$(git --no-optional-locks write-tree)
    unset GIT_INDEX_FILE
    rm -f "$IDX"
    POST=$(listing)
}

attempt
if [ "$PRE" != "$POST" ]; then attempt; fi
if [ "$PRE" != "$POST" ]; then TORN=1; else TORN=0; fi

if [ -n "${ENVMUX_PREV:-}" ]; then
    COMMIT=$(printf 'envmux capture %s\n' "$ENVMUX_TS" | git commit-tree "$TREE" -p "$ENVMUX_PREV")
else
    COMMIT=$(printf 'envmux capture %s\n' "$ENVMUX_TS" | git commit-tree "$TREE")
fi

EPOCH=$(date +%s)
TAG=$(printf 'object %s\ntype commit\ntag snap-%s\ntagger envmux <envmux@local> %s +0000\n\ntorn = %s\nflagged = "%s"\ncaptured_at = "%s"\n' \
    "$COMMIT" "$ENVMUX_TS_SAFE" "$EPOCH" \
    "$([ "$TORN" = 1 ] && echo true || echo false)" "$flagged" "$ENVMUX_TS" | git mktag)

git push --quiet --force "$ENVMUX_SHADOW" \
    "$COMMIT:refs/envmux/ws/$ENVMUX_WS/head" \
    "$TAG:refs/envmux/snap/$ENVMUX_WS/$ENVMUX_TS_SAFE"

branch=$(git --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

echo "commit=$COMMIT"
echo "tree=$TREE"
echo "torn=$TORN"
echo "flagged=$flagged"
echo "branch=$branch"
echo "head_ref=refs/envmux/ws/$ENVMUX_WS/head"
echo "snap_ref=refs/envmux/snap/$ENVMUX_WS/$ENVMUX_TS_SAFE"
"#;

/// §8.4 — one exec per workspace per tick; `--no-optional-locks` on every
/// invocation so observation never writes the index or takes a lock.
///
/// Env: `ENVMUX_WORKDIR`, `ENVMUX_DEPTH` (`full`|`cheap`), `ENVMUX_CAP`.
pub const OBSERVE_SCRIPT: &str = r#"
set -u
cd "$ENVMUX_WORKDIR"
G="git --no-optional-locks"

echo "branch=$($G rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
echo "head=$($G rev-parse HEAD 2>/dev/null || echo "")"

flagged=""
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then flagged="rebase"; fi
if [ -f .git/MERGE_HEAD ]; then flagged="merge"; fi
if [ -n "$($G ls-files -u 2>/dev/null | head -n1)" ]; then flagged="conflict"; fi
echo "flagged=$flagged"

if [ "${ENVMUX_DEPTH:-full}" = "cheap" ]; then
    if $G diff --quiet 2>/dev/null && $G diff --cached --quiet 2>/dev/null; then
        echo "dirty=0"
    else
        echo "dirty=1"
    fi
else
    CAP="${ENVMUX_CAP:-10000}"
    lines=$($G status --porcelain=v2 2>/dev/null | head -n "$((CAP + 1))" | wc -l | tr -d ' ')
    if [ "$lines" -gt "$CAP" ]; then
        echo "dirty_files=$CAP"
        echo "truncated=1"
    else
        echo "dirty_files=$lines"
        echo "truncated=0"
    fi
fi

ab=$($G rev-list --left-right --count "@{upstream}...HEAD" 2>/dev/null || echo "")
if [ -n "$ab" ]; then
    echo "behind=$(printf '%s' "$ab" | awk '{print $1}')"
    echo "ahead=$(printf '%s' "$ab" | awk '{print $2}')"
fi
"#;

fn parse_kv(output: &str) -> BTreeMap<&str, &str> {
    output
        .lines()
        .filter_map(|l| l.trim().split_once('='))
        .collect()
}

/// Result of one capture run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureOutcome {
    pub commit: String,
    pub tree: String,
    pub torn: bool,
    /// `rebase` / `merge` / `conflict`, or `None` for a clean state.
    pub flagged: Option<String>,
    pub branch: Option<String>,
    pub head_ref: String,
    pub snap_ref: String,
}

pub fn parse_capture_output(output: &str) -> Result<CaptureOutcome, GitError> {
    let kv = parse_kv(output);
    let get = |k: &str| {
        kv.get(k)
            .map(|v| (*v).to_owned())
            .ok_or_else(|| GitError::Parse(format!("capture output missing {k:?}: {output:?}")))
    };
    let optional = |k: &str| kv.get(k).filter(|v| !v.is_empty()).map(|v| (*v).to_owned());
    Ok(CaptureOutcome {
        commit: get("commit")?,
        tree: get("tree")?,
        torn: kv.get("torn").copied() == Some("1"),
        flagged: optional("flagged"),
        branch: optional("branch"),
        head_ref: get("head_ref")?,
        snap_ref: get("snap_ref")?,
    })
}

/// Result of one observation run. `dirty_files = None` in cheap mode.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObservationData {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub dirty: bool,
    pub dirty_files: Option<u32>,
    pub truncated: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub flagged: Option<String>,
}

pub fn parse_observation_output(output: &str) -> ObservationData {
    let kv = parse_kv(output);
    let optional = |k: &str| kv.get(k).filter(|v| !v.is_empty()).map(|v| (*v).to_owned());
    let num = |k: &str| kv.get(k).and_then(|v| v.parse::<u32>().ok());
    let dirty_files = num("dirty_files");
    ObservationData {
        branch: optional("branch").filter(|b| b != "HEAD"),
        head: optional("head"),
        dirty: kv.get("dirty").copied() == Some("1") || dirty_files.is_some_and(|n| n > 0),
        dirty_files,
        truncated: kv.get("truncated").copied() == Some("1"),
        ahead: num("ahead"),
        behind: num("behind"),
        flagged: optional("flagged"),
    }
}

/// Make an RFC 3339 timestamp safe for a ref name component.
#[must_use]
pub fn ref_safe_timestamp(ts: &jiff::Timestamp) -> String {
    ts.to_string().replace(':', "-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_output_parses() {
        let out = "commit=abc123\ntree=def456\ntorn=1\nflagged=rebase\nbranch=main\nhead_ref=refs/envmux/ws/x/head\nsnap_ref=refs/envmux/snap/x/2026-08-08T00-00-00Z\n";
        let c = parse_capture_output(out).unwrap();
        assert_eq!(c.commit, "abc123");
        assert!(c.torn);
        assert_eq!(c.flagged.as_deref(), Some("rebase"));
        assert_eq!(c.branch.as_deref(), Some("main"));
    }

    #[test]
    fn capture_output_clean() {
        let out = "commit=abc\ntree=def\ntorn=0\nflagged=\nbranch=\nhead_ref=r\nsnap_ref=s\n";
        let c = parse_capture_output(out).unwrap();
        assert!(!c.torn);
        assert_eq!(c.flagged, None);
        assert_eq!(c.branch, None);
    }

    #[test]
    fn capture_output_missing_key_errors() {
        assert!(parse_capture_output("torn=0\n").is_err());
    }

    #[test]
    fn observation_full_mode() {
        let out =
            "branch=main\nhead=abc\nflagged=\ndirty_files=11\ntruncated=0\nbehind=3\nahead=1\n";
        let o = parse_observation_output(out);
        assert_eq!(o.branch.as_deref(), Some("main"));
        assert!(o.dirty);
        assert_eq!(o.dirty_files, Some(11));
        assert_eq!(o.ahead, Some(1));
        assert_eq!(o.behind, Some(3));
        assert_eq!(o.flagged, None);
    }

    #[test]
    fn observation_cheap_mode_and_detached() {
        let o = parse_observation_output("branch=HEAD\nhead=abc\ndirty=1\nflagged=merge\n");
        assert_eq!(o.branch, None); // detached HEAD is not a branch
        assert!(o.dirty);
        assert_eq!(o.dirty_files, None);
        assert_eq!(o.flagged.as_deref(), Some("merge"));
    }

    #[test]
    fn ref_safe_timestamps_have_no_colons() {
        let ts: jiff::Timestamp = "2026-08-08T13:47:00Z".parse().unwrap();
        let safe = ref_safe_timestamp(&ts);
        assert!(!safe.contains(':'));
        assert!(safe.starts_with("2026-08-08T13-47-00"));
    }
}
