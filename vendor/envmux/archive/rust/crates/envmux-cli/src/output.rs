//! Output contract: human tables to a TTY, `--porcelain` = stable
//! tab-separated columns (versioned, additions append-only), `--json` = one
//! object per line.

use comfy_table::{ContentArrangement, Table};
use envmux_api_types::WorkspaceSummary;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Human,
    Porcelain,
    Json,
}

impl Format {
    #[must_use]
    pub fn from_flags(porcelain: bool, json: bool) -> Self {
        if json {
            Self::Json
        } else if porcelain {
            Self::Porcelain
        } else {
            Self::Human
        }
    }
}

/// Render an age like `4m` / `2h` / `3d` from an RFC 3339 stamp.
#[must_use]
pub fn age(ts: &str) -> String {
    let Ok(at) = ts.parse::<jiff::Timestamp>() else {
        return "?".into();
    };
    let secs = jiff::Timestamp::now().as_second() - at.as_second();
    humanize(secs)
}

/// Render time-until like `6d` or `-2h` (negative = past due).
#[must_use]
pub fn until(ts: &str) -> String {
    let Ok(at) = ts.parse::<jiff::Timestamp>() else {
        return "?".into();
    };
    let secs = at.as_second() - jiff::Timestamp::now().as_second();
    if secs < 0 {
        format!("-{}", humanize(-secs))
    } else {
        humanize(secs)
    }
}

fn humanize(secs: i64) -> String {
    let secs = secs.max(0);
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86400)
    }
}

/// The workspace listing: designed to be scanned and grepped. Porcelain
/// column set v1 (append-only): name, state, branch, head, dirty, ahead,
/// behind, tasks, death, `observed_at`, namespace, id.
pub fn workspaces(rows: &[WorkspaceSummary], format: Format) {
    match format {
        Format::Json => {
            for row in rows {
                println!("{}", serde_json::to_string(row).expect("serializable"));
            }
        }
        Format::Porcelain => {
            for w in rows {
                let o = w.observation.as_ref();
                println!(
                    "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    w.name,
                    w.state,
                    o.and_then(|o| o.branch.as_deref()).unwrap_or("-"),
                    o.and_then(|o| o.head.as_deref())
                        .map(|h| &h[..h.len().min(10)])
                        .unwrap_or("-"),
                    o.map(|o| dirty_cell(o)).unwrap_or_else(|| "-".into()),
                    o.and_then(|o| o.ahead)
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| "-".into()),
                    o.and_then(|o| o.behind)
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| "-".into()),
                    o.map(|o| running_tasks(o)).unwrap_or_else(|| "-".into()),
                    w.death_date.as_deref().unwrap_or("pinned"),
                    o.map(|o| o.observed_at.clone())
                        .unwrap_or_else(|| "-".into()),
                    w.namespace,
                    w.id,
                );
            }
        }
        Format::Human => {
            let mut table = Table::new();
            table
                .set_content_arrangement(ContentArrangement::Dynamic)
                .set_header(vec![
                    "NAME", "STATE", "BRANCH", "HEAD", "DIRTY", "±", "TASKS", "DIES", "OBSERVED",
                ]);
            for w in rows {
                let o = w.observation.as_ref();
                table.add_row(vec![
                    w.name.clone(),
                    w.state.to_string(),
                    o.and_then(|o| o.branch.clone())
                        .unwrap_or_else(|| "-".into()),
                    o.and_then(|o| o.head.clone())
                        .map(|h| h[..h.len().min(10)].to_owned())
                        .unwrap_or_else(|| "-".into()),
                    o.map(|o| dirty_cell(o)).unwrap_or_else(|| "-".into()),
                    o.map(|o| {
                        format!(
                            "{}/{}",
                            o.ahead.map_or("-".into(), |n| n.to_string()),
                            o.behind.map_or("-".into(), |n| n.to_string())
                        )
                    })
                    .unwrap_or_else(|| "-".into()),
                    o.map(|o| running_tasks(o)).unwrap_or_else(|| "-".into()),
                    w.death_date
                        .as_deref()
                        .map(until)
                        .unwrap_or_else(|| "pinned".into()),
                    o.map(|o| age(&o.observed_at))
                        .unwrap_or_else(|| "never".into()),
                ]);
            }
            println!("{table}");
        }
    }
}

fn dirty_cell(o: &envmux_api_types::Observation) -> String {
    match (o.dirty, o.dirty_files, o.truncated) {
        (false, ..) => "clean".into(),
        (true, Some(n), false) => format!("{n}"),
        (true, Some(n), true) => format!("{n}+"),
        (true, None, _) => "dirty".into(),
    }
}

fn running_tasks(o: &envmux_api_types::Observation) -> String {
    let running = o
        .tasks
        .iter()
        .filter(|t| {
            matches!(
                t.state,
                envmux_api_types::TaskState::Running | envmux_api_types::TaskState::Ready
            )
        })
        .count();
    format!("{running}/{}", o.tasks.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanize_ranges() {
        assert_eq!(humanize(30), "30s");
        assert_eq!(humanize(120), "2m");
        assert_eq!(humanize(7200), "2h");
        assert_eq!(humanize(200_000), "2d");
    }
}
