//! Human-friendly durations for config values: `"90s"`, `"15m"`, `"24h"`,
//! `"7d"`, or compounds like `"1d 12h"`. Serialized back out in the same form.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// A duration parsed from a human-friendly string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HumanDuration(pub Duration);

impl HumanDuration {
    #[must_use]
    pub const fn from_secs(secs: u64) -> Self {
        Self(Duration::from_secs(secs))
    }

    #[must_use]
    pub fn as_secs(self) -> u64 {
        self.0.as_secs()
    }

    #[must_use]
    pub fn as_std(self) -> Duration {
        self.0
    }

    /// Convert to a jiff span for death-date arithmetic (seconds precision).
    #[must_use]
    pub fn to_jiff(self) -> jiff::Span {
        #[allow(clippy::cast_possible_wrap)] // config durations are nowhere near i64::MAX seconds
        jiff::Span::new().seconds(self.0.as_secs() as i64)
    }
}

impl FromStr for HumanDuration {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut total: u64 = 0;
        let mut any = false;
        for token in s.split_whitespace() {
            let split = token
                .find(|c: char| !c.is_ascii_digit())
                .ok_or_else(|| format!("duration token {token:?} is missing a unit (s/m/h/d)"))?;
            let (num, unit) = token.split_at(split);
            let n: u64 = num
                .parse()
                .map_err(|_| format!("duration token {token:?} has an invalid number"))?;
            let mult = match unit {
                "s" | "sec" | "secs" => 1,
                "m" | "min" | "mins" => 60,
                "h" | "hr" | "hrs" | "hour" | "hours" => 3600,
                "d" | "day" | "days" => 86400,
                _ => {
                    return Err(format!(
                        "duration token {token:?} has unknown unit {unit:?}"
                    ));
                }
            };
            total = total
                .checked_add(n.checked_mul(mult).ok_or("duration overflows")?)
                .ok_or("duration overflows")?;
            any = true;
        }
        if !any {
            return Err(format!("empty duration {s:?}"));
        }
        Ok(Self(Duration::from_secs(total)))
    }
}

impl fmt::Display for HumanDuration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut secs = self.0.as_secs();
        if secs == 0 {
            return f.write_str("0s");
        }
        let mut parts = Vec::new();
        for (unit, size) in [("d", 86400), ("h", 3600), ("m", 60), ("s", 1)] {
            if secs >= size {
                parts.push(format!("{}{unit}", secs / size));
                secs %= size;
            }
        }
        f.write_str(&parts.join(" "))
    }
}

impl Serialize for HumanDuration {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for HumanDuration {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_units() {
        assert_eq!(HumanDuration::from_str("90s").unwrap().as_secs(), 90);
        assert_eq!(HumanDuration::from_str("15m").unwrap().as_secs(), 900);
        assert_eq!(HumanDuration::from_str("24h").unwrap().as_secs(), 86400);
        assert_eq!(HumanDuration::from_str("7d").unwrap().as_secs(), 604_800);
        assert_eq!(
            HumanDuration::from_str("1d 12h").unwrap().as_secs(),
            129_600
        );
    }

    #[test]
    fn rejects_garbage() {
        for bad in ["", "10", "x", "10w", "-5m"] {
            assert!(HumanDuration::from_str(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn display_round_trips() {
        for s in ["90s", "15m", "1d 12h", "7d"] {
            let d = HumanDuration::from_str(s).unwrap();
            assert_eq!(d.to_string().parse::<HumanDuration>().unwrap(), d);
        }
        assert_eq!(HumanDuration::from_secs(90).to_string(), "1m 30s");
    }
}
