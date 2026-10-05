//! Periodic workers, all following the same shape: an owned
//! `tokio::time::interval` with `MissedTickBehavior::Delay` plus ±10% jitter,
//! cancellation observed at every await point that matters. Wall-clock
//! correctness lives in stamped death dates, not the scheduler.

pub mod capture;
pub mod disk;
pub mod idle;
pub mod mirror_sync;
pub mod observer;
pub mod reaper;

use std::time::Duration;

use rand::Rng as _;

/// An interval with delay-on-missed-tick semantics and ±10% jitter.
pub fn jittered_interval(period: Duration) -> tokio::time::Interval {
    let secs = period.as_secs_f64();
    let jitter = rand::thread_rng().gen_range(-0.1..0.1);
    let jittered = Duration::from_secs_f64((secs * (1.0 + jitter)).max(1.0));
    let mut interval = tokio::time::interval(jittered);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval
}
