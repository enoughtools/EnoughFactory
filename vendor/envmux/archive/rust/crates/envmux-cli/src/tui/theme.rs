//! The look: neon on near-black, 1985-imagining-2050.
//!
//! Colours are declared once here so the whole surface stays coherent — a TUI
//! that reaches for a different magenta in every pane reads as a mess rather
//! than a style. Everything is 24-bit RGB; terminals that cannot manage it
//! degrade to their nearest palette entry, which still looks deliberate
//! because the hues are far apart.

use ratatui::style::{Color, Modifier, Style};

/// The void behind everything.
pub const VOID: Color = Color::Rgb(0x0a, 0x01, 0x18);

/// The primary accent. Used for chrome, selection, and the wordmark.
pub const NEON: Color = Color::Rgb(0xff, 0x2b, 0xd6);
/// The secondary accent, for data the eye should land on.
pub const CYAN: Color = Color::Rgb(0x00, 0xf0, 0xff);
/// Healthy, ready, connected.
pub const ACID: Color = Color::Rgb(0x39, 0xff, 0x14);
/// Attention without alarm.
pub const AMBER: Color = Color::Rgb(0xff, 0xb0, 0x00);
/// Alarm.
pub const BLOOD: Color = Color::Rgb(0xff, 0x30, 0x50);
/// Body text.
pub const TEXT: Color = Color::Rgb(0xd8, 0xdc, 0xe3);
/// Secondary text: present, not competing.
pub const DIM: Color = Color::Rgb(0x6b, 0x5f, 0x8a);
/// Inactive chrome.
pub const GHOST: Color = Color::Rgb(0x3a, 0x2d, 0x52);

/// Base style: every widget starts from the void so no terminal's default
/// background bleeds through a gap.
#[must_use]
pub fn base() -> Style {
    Style::default().bg(VOID).fg(TEXT)
}

#[must_use]
pub fn panel(focused: bool) -> Style {
    Style::default()
        .bg(VOID)
        .fg(if focused { NEON } else { GHOST })
}

#[must_use]
pub fn title(focused: bool) -> Style {
    let style = Style::default().fg(if focused { CYAN } else { DIM });
    if focused {
        style.add_modifier(Modifier::BOLD)
    } else {
        style
    }
}

#[must_use]
pub fn selected() -> Style {
    Style::default()
        .bg(Color::Rgb(0x2a, 0x0a, 0x3e))
        .fg(CYAN)
        .add_modifier(Modifier::BOLD)
}

#[must_use]
pub fn faint() -> Style {
    Style::default().fg(DIM)
}

#[must_use]
pub fn key() -> Style {
    Style::default().fg(ACID).add_modifier(Modifier::BOLD)
}

/// The colour a workspace or task state should be read in. States are the main
/// thing scanned for, so they get the strongest signal on screen.
///
/// Both vocabularies share this map. They overlap only on `ready`, where they
/// mean the same thing, and keeping one table means a task state can never be
/// the one that quietly falls through to grey.
#[must_use]
pub fn state_colour(state: &str) -> Color {
    match state {
        // Workspaces.
        "ready" => ACID,
        "provisioning" => CYAN,
        "degraded" | "reaping" => AMBER,
        "lost" => BLOOD,
        // Tasks.
        "running" => CYAN,
        "failed" => BLOOD,
        "exited" => AMBER,
        _ => DIM,
    }
}

#[must_use]
pub fn level_colour(level: &str) -> Color {
    match level {
        "error" => BLOOD,
        "warn" => AMBER,
        "info" => CYAN,
        _ => DIM,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_state_has_a_colour_and_unknown_ones_are_not_loud() {
        for state in [
            "ready",
            "provisioning",
            "degraded",
            "reaping",
            "lost",
            // Task states go through the same table; a failed task rendering
            // as grey is exactly the thing this table exists to prevent.
            "running",
            "failed",
            "exited",
        ] {
            assert_ne!(state_colour(state), DIM, "{state} should stand out");
        }
        assert_eq!(state_colour("failed"), BLOOD, "a failure must read as one");
        // An unrecognised state must not be painted as healthy.
        assert_eq!(state_colour("something-new"), DIM);
        assert_eq!(state_colour("reaped"), DIM);
    }
}
