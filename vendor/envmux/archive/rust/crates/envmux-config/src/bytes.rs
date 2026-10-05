//! Human-friendly byte sizes for config values: `"512m"`, `"8g"`, `"1.5gb"`,
//! `"2GiB"`, or a bare byte count. Serialized back out in the same form.
//!
//! This exists because the previous ad-hoc parser returned `Option` and the
//! caller treated `None` as *no limit*. A typo (`"12gb"`), a decimal
//! (`"1.5g"`), or an unhandled unit (`"512k"`) therefore removed the limit
//! silently — the opposite of what was written. Sizes are parsed when the
//! config is loaded so a bad value is a diagnostic pointing at the key, never
//! a limit that quietly is not there.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

const KI: u64 = 1024;
const MI: u64 = 1024 * KI;
const GI: u64 = 1024 * MI;
const TI: u64 = 1024 * GI;

/// A byte size parsed from a human-friendly string.
///
/// Units are binary (`1k` = 1024), matching Docker's own interpretation of
/// `--memory`, so a declared limit means what the container runtime applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct ByteSize(pub u64);

impl ByteSize {
    #[must_use]
    pub const fn from_bytes(bytes: u64) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(self) -> u64 {
        self.0
    }

    /// Byte count as `i64` for the Docker API, saturating rather than wrapping.
    #[must_use]
    pub fn as_i64(self) -> i64 {
        i64::try_from(self.0).unwrap_or(i64::MAX)
    }

    /// A zero size, which every consumer reads as "no limit".
    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }
}

impl FromStr for ByteSize {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return Err("empty size".to_owned());
        }
        let lower = trimmed.to_ascii_lowercase();
        let split = lower
            .find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(lower.len());
        let (num, unit) = lower.split_at(split);
        let unit = unit.trim();

        let mult = match unit {
            "" | "b" => 1,
            "k" | "kb" | "kib" => KI,
            "m" | "mb" | "mib" => MI,
            "g" | "gb" | "gib" => GI,
            "t" | "tb" | "tib" => TI,
            _ => {
                return Err(format!(
                    "size {s:?} has unknown unit {unit:?} (use b, k, m, g, or t)"
                ));
            }
        };

        let value: f64 = num
            .parse()
            .map_err(|_| format!("size {s:?} has an invalid number {num:?}"))?;
        if !value.is_finite() || value < 0.0 {
            return Err(format!("size {s:?} must be a non-negative number"));
        }
        #[allow(clippy::cast_precision_loss, clippy::cast_sign_loss)]
        let bytes = value * mult as f64;
        if bytes > u64::MAX as f64 {
            return Err(format!("size {s:?} overflows"));
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Ok(Self(bytes as u64))
    }
}

impl fmt::Display for ByteSize {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let b = self.0;
        // Render in the largest unit that divides exactly, so a round-trip of
        // a hand-written value stays recognisable.
        for (unit, size) in [("t", TI), ("g", GI), ("m", MI), ("k", KI)] {
            if b >= size && b.is_multiple_of(size) {
                return write!(f, "{}{unit}", b / size);
            }
        }
        write!(f, "{b}")
    }
}

impl Serialize for ByteSize {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for ByteSize {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // Accept a bare integer as bytes as well as a string, because TOML
        // authors reasonably write `max_context = 0` to disable a limit.
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = ByteSize;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a byte size such as \"8g\", or a number of bytes")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<ByteSize, E> {
                v.parse().map_err(E::custom)
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<ByteSize, E> {
                Ok(ByteSize(v))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<ByteSize, E> {
                u64::try_from(v)
                    .map(ByteSize)
                    .map_err(|_| E::custom("size must be non-negative"))
            }
        }
        d.deserialize_any(V)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_units_as_binary() {
        assert_eq!(ByteSize::from_str("1024").unwrap().as_bytes(), 1024);
        assert_eq!(ByteSize::from_str("1k").unwrap().as_bytes(), KI);
        assert_eq!(ByteSize::from_str("8g").unwrap().as_bytes(), 8 * GI);
        assert_eq!(ByteSize::from_str("2t").unwrap().as_bytes(), 2 * TI);
    }

    #[test]
    fn accepts_the_spellings_people_actually_write() {
        // Every one of these silently meant "no limit" under the old parser.
        for (input, expected) in [
            ("12gb", 12 * GI),
            ("12GB", 12 * GI),
            ("12GiB", 12 * GI),
            ("8G", 8 * GI),
            ("512k", 512 * KI),
            ("  8g  ", 8 * GI),
        ] {
            assert_eq!(
                ByteSize::from_str(input).unwrap().as_bytes(),
                expected,
                "{input:?}"
            );
        }
    }

    #[test]
    fn accepts_fractional_sizes() {
        assert_eq!(ByteSize::from_str("1.5g").unwrap().as_bytes(), GI + GI / 2);
        assert_eq!(ByteSize::from_str("0.5m").unwrap().as_bytes(), MI / 2);
    }

    #[test]
    fn rejects_garbage_instead_of_meaning_unlimited() {
        // The whole point: a value that cannot be understood is an error, not
        // a silently absent limit.
        for bad in ["", "g", "12x", "-5g", "1.2.3g", "abc"] {
            assert!(ByteSize::from_str(bad).is_err(), "{bad:?} should not parse");
        }
    }

    #[test]
    fn zero_is_a_valid_explicit_no_limit() {
        let z = ByteSize::from_str("0").unwrap();
        assert!(z.is_zero());
        assert_eq!(z.as_bytes(), 0);
    }

    #[test]
    fn display_round_trips() {
        for s in ["8g", "512m", "1k", "2t"] {
            let size = ByteSize::from_str(s).unwrap();
            assert_eq!(size.to_string(), s);
            assert_eq!(size.to_string().parse::<ByteSize>().unwrap(), size);
        }
        // Non-round values fall back to a plain byte count.
        assert_eq!(ByteSize::from_bytes(1536).to_string(), "1536");
    }

    #[test]
    fn deserializes_from_string_or_integer() {
        #[derive(serde::Deserialize)]
        struct Holder {
            size: ByteSize,
        }
        let s: Holder = toml::from_str(r#"size = "8g""#).unwrap();
        assert_eq!(s.size.as_bytes(), 8 * GI);
        let n: Holder = toml::from_str("size = 0").unwrap();
        assert!(n.size.is_zero());
    }
}
