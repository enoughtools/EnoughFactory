//! The wordmark, panel frames, and the decorative furniture.
//!
//! Decoration has to earn its rows. The wordmark no longer sits across the top
//! taking space from the panes; it appears only at the bottom of the detail
//! pane when there is nothing selected to fill it — space that was blank
//! anyway — and it shrinks to whatever that pane can actually hold.

use ratatui::Frame;
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};

use super::theme;

/// The wordmark, in blocks. Six rows, drawn only where there is room — which
/// means a wide terminal, since the pane it lives in is a narrow column.
const WORDMARK: [&str; 6] = [
    "███████╗███╗   ██╗██╗   ██╗███╗   ███╗██╗   ██╗██╗  ██╗",
    "██╔════╝████╗  ██║██║   ██║████╗ ████║██║   ██║╚██╗██╔╝",
    "█████╗  ██╔██╗ ██║██║   ██║██╔████╔██║██║   ██║ ╚███╔╝ ",
    "██╔══╝  ██║╚██╗██║╚██╗ ██╔╝██║╚██╔╝██║██║   ██║ ██╔██╗ ",
    "███████╗██║ ╚████║ ╚████╔╝ ██║ ╚═╝ ██║╚██████╔╝██╔╝ ██╗",
    "╚══════╝╚═╝  ╚═══╝  ╚═══╝  ╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝",
];

/// The wordmark for everywhere the block form does not fit, which is most
/// places.
const COMPACT: &str = "▚▚ E N V M U X ▚▚";

/// Dropped first of all: it is the least of the three things here.
const TAGLINE: &str = "disposable workspaces";

/// Which form of the mark a rectangle can hold.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Form {
    Block,
    Compact,
}

fn form(area: Rect) -> Option<Form> {
    let width = usize::from(area.width);
    let rows = u16::try_from(WORDMARK.len()).unwrap_or(u16::MAX);
    if width >= WORDMARK[0].chars().count() && area.height >= rows {
        Some(Form::Block)
    } else if width >= COMPACT.chars().count() && area.height >= 1 {
        Some(Form::Compact)
    } else {
        None
    }
}

/// How many rows [`logo`] would use in `area`, so a caller can reserve them at
/// the bottom of a pane before drawing anything else into it.
///
/// Zero when the space is too small for the mark to read as one — a clipped
/// wordmark looks like a bug, and the pane's own message matters more.
#[must_use]
pub fn logo_height(area: Rect) -> u16 {
    let rows = match form(area) {
        Some(Form::Block) => u16::try_from(WORDMARK.len()).unwrap_or(u16::MAX),
        Some(Form::Compact) => 1,
        None => return 0,
    };
    if area.height > rows && usize::from(area.width) >= TAGLINE.chars().count() {
        rows + 1
    } else {
        rows
    }
}

/// Draw the mark, filling `area` — which should be exactly [`logo_height`]
/// rows tall, so it lands where the caller reserved it.
pub fn logo(frame: &mut Frame, area: Rect) {
    let Some(form) = form(area) else {
        return;
    };

    let mut lines: Vec<Line> = match form {
        // A vertical gradient: hot at the top, cooling downward. Cheap, and it
        // stops the block letters reading as a flat slab.
        Form::Block => WORDMARK
            .iter()
            .enumerate()
            .map(|(row, art)| {
                let colour = if row < 2 { theme::NEON } else { theme::CYAN };
                Line::from(Span::styled(
                    (*art).to_owned(),
                    Style::default().fg(colour).add_modifier(Modifier::BOLD),
                ))
            })
            .collect(),
        Form::Compact => vec![Line::from(Span::styled(
            COMPACT.to_owned(),
            Style::default()
                .fg(theme::NEON)
                .add_modifier(Modifier::BOLD),
        ))],
    };

    if lines.len() < usize::from(area.height) && usize::from(area.width) >= TAGLINE.chars().count()
    {
        lines.push(Line::from(Span::styled(TAGLINE.to_owned(), theme::faint())));
    }

    frame.render_widget(
        Paragraph::new(lines)
            .alignment(Alignment::Center)
            .style(theme::base()),
        area,
    );
}

/// A double-ruled block with a bracketed title, the standard panel frame.
#[must_use]
pub fn block(title: &str, focused: bool) -> Block<'static> {
    use ratatui::widgets::{BorderType, Borders};
    Block::default()
        .borders(Borders::ALL)
        .border_type(if focused {
            BorderType::Double
        } else {
            BorderType::Plain
        })
        .border_style(theme::panel(focused))
        .title(Line::from(vec![
            Span::styled("┤ ", theme::panel(focused)),
            // Verbatim. Titles are lowercase because they are written that
            // way, and a pane that shouts its own name at you is decoration
            // charged to the reader — worse when the string is a branch or a
            // namespace somebody actually chose.
            Span::styled(title.to_owned(), theme::title(focused)),
            Span::styled(" ├", theme::panel(focused)),
        ]))
        .style(theme::base())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wordmark_is_rectangular() {
        // Ragged rows would tear the centred mark differently per line.
        let widths: Vec<usize> = WORDMARK.iter().map(|r| r.chars().count()).collect();
        assert!(
            widths.windows(2).all(|w| w[0] == w[1]),
            "wordmark rows differ in width: {widths:?}"
        );
    }

    #[test]
    fn the_logo_never_asks_for_more_room_than_it_was_offered() {
        // The caller reserves this at the bottom of a pane; over-asking would
        // push the pane's own message off the top of it.
        for width in [0_u16, 1, 12, 17, 21, 34, 55, 80] {
            for height in 0_u16..12 {
                let area = Rect::new(0, 0, width, height);
                assert!(
                    logo_height(area) <= height,
                    "{width}x{height} wanted {} rows",
                    logo_height(area)
                );
            }
        }
    }

    #[test]
    fn a_pane_too_narrow_for_the_mark_gets_none_of_it() {
        // Half a wordmark reads as a rendering fault, not as a logo.
        assert_eq!(logo_height(Rect::new(0, 0, 10, 6)), 0);
        // The narrow column the detail pane actually is: the compact form,
        // with the tagline under it.
        assert_eq!(logo_height(Rect::new(0, 0, 34, 6)), 2);
        // Wide enough for the blocks, and a row spare for the tagline.
        assert_eq!(
            logo_height(Rect::new(0, 0, 60, 8)),
            u16::try_from(WORDMARK.len()).expect("fits") + 1
        );
        // Wide, but too short for the blocks: it falls back rather than
        // clipping them.
        assert_eq!(logo_height(Rect::new(0, 0, 60, 2)), 2);
    }
}
