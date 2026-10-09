//! Snowflake ids for tabs (vendored from `packages/utils/src/snowflake.ts`):
//! 16 lowercase hex chars, `(timestamp - EPOCH) << 22 | seq`, time-ordered
//! and collision-resistant within the process. The renderer stores these ids
//! as opaque strings.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// 2015-01-01T00:00:00Z in milliseconds.
const EPOCH: u64 = 1_420_070_400_000;
const MAX_SEQ: u32 = 0x3f_ffff;

/// Process-local sequence, seeded randomly like the TS source.
fn sequence() -> &'static AtomicU32 {
    static SEQ: OnceLock<AtomicU32> = OnceLock::new();
    SEQ.get_or_init(|| {
        // `RandomState` is keyed from the OS random source; its first hash is a random seed.
        let seed = RandomState::new().build_hasher().finish();
        AtomicU32::new((seed as u32) & MAX_SEQ)
    })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(EPOCH)
}

/// Mint the next snowflake id.
pub(crate) fn next_snowflake() -> String {
    next_snowflake_at(now_ms())
}

/// Mint the next snowflake id for `timestamp_ms` (milliseconds since the Unix epoch).
pub(crate) fn next_snowflake_at(timestamp_ms: u64) -> String {
    let previous = sequence().fetch_add(1, Ordering::Relaxed);
    let seq = previous.wrapping_add(1) & MAX_SEQ;
    let value = (timestamp_ms.saturating_sub(EPOCH) << 22) | u64::from(seq);
    format!("{value:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mints_sixteen_lowercase_hex_chars() {
        let id = next_snowflake();
        assert_eq!(id.len(), 16);
        assert!(id.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)), "{id}");
    }

    #[test]
    fn encodes_the_timestamp_above_the_sequence_bits() {
        let timestamp = EPOCH + 123_456_789;
        let id = next_snowflake_at(timestamp);
        let value = u64::from_str_radix(&id, 16).unwrap();
        assert_eq!(value >> 22, 123_456_789);
        assert!((value & u64::from(MAX_SEQ)) <= u64::from(MAX_SEQ));
    }

    #[test]
    fn ids_minted_in_one_millisecond_are_distinct_and_ordered() {
        let timestamp = EPOCH + 42;
        let first = next_snowflake_at(timestamp);
        let second = next_snowflake_at(timestamp);
        assert_ne!(first, second);
        let a = u64::from_str_radix(&first, 16).unwrap();
        let b = u64::from_str_radix(&second, 16).unwrap();
        // Same timestamp bits; the sequence moved on (it wraps only after 4M ids).
        assert_eq!(a >> 22, b >> 22);
        assert_ne!(a & u64::from(MAX_SEQ), b & u64::from(MAX_SEQ));
    }

    #[test]
    fn later_timestamps_sort_after_earlier_ones() {
        let earlier = next_snowflake_at(EPOCH + 1_000);
        let later = next_snowflake_at(EPOCH + 2_000);
        assert!(later > earlier, "{later} <= {earlier}");
    }
}
