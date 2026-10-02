//! The stamped LRU behind both session-index caches, ported from
//! `session-cache.ts`'s `StampedLru`.
//!
//! Entries key by path and carry the `mtime:size` signature they were read
//! at, so re-reading a changed file replaces its slot instead of adding a
//! second one, and invalidation is a single delete per watcher event rather
//! than a scan over every cached key. Capacity is a caller-chosen weight:
//! entry count for parsed headers, bytes for cached search text.

use std::collections::{BTreeMap, HashMap};

struct Stamped<V> {
    signature: String,
    value: V,
    /// Monotonic recency key: the position in `order` doubles as the Map
    /// iteration order `StampedLru` relies on in TypeScript (oldest first).
    order_key: u64,
}

/// Bounded cache with an explicit weight function, mirroring `StampedLru<V>`.
pub struct StampedLru<V> {
    entries: HashMap<String, Stamped<V>>,
    /// Maps the recency key back to its entry's cache key, in insertion
    /// (recency) order; the first item is the least recently used.
    order: BTreeMap<u64, String>,
    next_order: u64,
    used: usize,
    capacity: usize,
    size_of: Box<dyn Fn(&V) -> usize + Send + Sync>,
}

impl<V> StampedLru<V> {
    /// A cache whose weight is the entry count (`sizeOf` defaulting to `1`).
    pub fn new(capacity: usize) -> Self {
        Self::with_size_of(capacity, |_| 1)
    }

    pub fn with_size_of(capacity: usize, size_of: impl Fn(&V) -> usize + Send + Sync + 'static) -> Self {
        Self { entries: HashMap::new(), order: BTreeMap::new(), next_order: 0, used: 0, capacity, size_of: Box::new(size_of) }
    }

    /// Cached value for `key`, or `None` when absent or read at a different signature.
    pub fn get(&mut self, key: &str, signature: &str) -> Option<&V>
    where
        V: Clone,
    {
        let matches = matches!(self.entries.get(key), Some(entry) if entry.signature == signature);
        if !matches {
            return None;
        }
        // Re-insert so this entry becomes the most recently used (bumps its order key).
        let entry = self.entries.remove(key).unwrap_or_else(|| unreachable!("checked above"));
        self.order.remove(&entry.order_key);
        let order_key = self.next_order;
        self.next_order += 1;
        self.order.insert(order_key, key.to_string());
        self.entries.insert(key.to_string(), Stamped { signature: entry.signature, value: entry.value, order_key });
        self.entries.get(key).map(|entry| &entry.value)
    }

    pub fn set(&mut self, key: &str, signature: &str, value: V) {
        self.delete(key);
        let weight = (self.size_of)(&value);
        // An entry that alone exceeds the budget is not kept: caching it would
        // make the ceiling a lie, and evicting everything else to fit it is worse.
        if weight > self.capacity {
            return;
        }
        self.used += weight;
        let order_key = self.next_order;
        self.next_order += 1;
        self.order.insert(order_key, key.to_string());
        self.entries.insert(key.to_string(), Stamped { signature: signature.to_string(), value, order_key });
        while self.used > self.capacity && self.entries.len() > 1 {
            let Some((&oldest_order, oldest_key)) = self.order.iter().next() else { break };
            let oldest_key = oldest_key.clone();
            let _ = oldest_order;
            self.delete(&oldest_key);
        }
    }

    pub fn delete(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.used -= (self.size_of)(&entry.value);
            self.order.remove(&entry.order_key);
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.used = 0;
    }

    // Exercised by this module's own tests; kept for parity with `StampedLru`'s
    // TS `size`/`used` getters even though no production caller reads them yet.
    #[allow(dead_code)]
    pub fn size(&self) -> usize {
        self.entries.len()
    }

    /// Weight currently held, in the unit the capacity was given in.
    #[allow(dead_code)]
    pub fn used(&self) -> usize {
        self.used
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_one_slot_per_key_instead_of_a_slot_per_generation() {
        let mut cache = StampedLru::<String>::new(8);
        cache.set("/s/a.jsonl", "1:10", "first read".to_string());
        cache.set("/s/a.jsonl", "2:20", "second read".to_string());
        // The old key included the signature, so every re-read added an entry
        // that nothing could reach and invalidation had to scan for.
        assert_eq!(cache.size(), 1);
        assert_eq!(cache.used(), 1);
        assert_eq!(cache.get("/s/a.jsonl", "2:20"), Some(&"second read".to_string()));
        assert_eq!(cache.get("/s/a.jsonl", "1:10"), None);
    }

    #[test]
    fn evicts_the_oldest_slot_once_the_budget_is_full() {
        let mut cache = StampedLru::<String>::new(2);
        cache.set("a", "s", "A".to_string());
        cache.set("b", "s", "B".to_string());
        assert_eq!(cache.get("c", "s"), None);
        cache.set("c", "s", "C".to_string());
        assert_eq!(cache.get("a", "s"), None);
        assert_eq!(cache.get("b", "s"), Some(&"B".to_string()));
        assert_eq!(cache.get("c", "s"), Some(&"C".to_string()));
    }

    // The `V = String` weight closure must take `&String` to match
    // `with_size_of`'s `Fn(&V) -> usize` bound exactly.
    #[allow(clippy::ptr_arg)]
    fn bytes(value: &String) -> usize {
        value.len()
    }

    #[test]
    fn counts_what_it_holds_rather_than_how_many_things_it_holds() {
        let mut cache = StampedLru::<String>::with_size_of(100, bytes);
        cache.set("a", "s", "x".repeat(60));
        cache.set("b", "s", "y".repeat(60));
        assert!(cache.used() <= 100);
        // Inserting b evicted a: an entry-count ceiling would have kept both.
        assert_eq!(cache.get("a", "s"), None);
        assert_eq!(cache.get("b", "s").map(String::len), Some(60));
    }

    #[test]
    fn drops_an_entry_that_cannot_fit_even_in_an_empty_cache() {
        let mut cache = StampedLru::<String>::with_size_of(10, bytes);
        cache.set("big", "s", "x".repeat(50));
        assert_eq!(cache.size(), 0);
        assert_eq!(cache.used(), 0);
        // The room the oversize entry did not take is still usable.
        cache.set("small", "s", "ok".to_string());
        assert_eq!(cache.get("small", "s"), Some(&"ok".to_string()));
    }

    #[test]
    fn refuses_a_value_stored_at_another_signature() {
        let mut cache = StampedLru::<String>::with_size_of(100, bytes);
        cache.set("f", "11:4", "abcd".to_string());
        // Same length, new mtime: the file was rewritten, so the old text is wrong.
        assert_eq!(cache.get("f", "22:4"), None);
        assert_eq!(cache.get("f", "11:4"), Some(&"abcd".to_string()));
    }

    #[test]
    fn releases_the_weight_of_a_deleted_key() {
        let mut cache = StampedLru::<String>::with_size_of(100, bytes);
        cache.set("f", "s", "x".repeat(90));
        assert_eq!(cache.used(), 90);
        cache.delete("f");
        assert_eq!(cache.used(), 0);
        cache.set("g", "s", "x".repeat(90));
        assert_eq!(cache.get("g", "s").map(String::len), Some(90));
    }

    #[test]
    fn clears_everything_without_leaking_weight() {
        let mut cache = StampedLru::<String>::with_size_of(100, bytes);
        cache.set("f", "s", "abc".to_string());
        cache.clear();
        assert_eq!(cache.size(), 0);
        assert_eq!(cache.used(), 0);
    }
}
