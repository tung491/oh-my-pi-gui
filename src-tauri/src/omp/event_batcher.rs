//! Batches agent session events at roughly one 30 Hz presentation frame,
//! ported from `src/main/event-batcher.ts`. Never drops `message_update` or
//! lifecycle events; drops intermediate `tool_execution_update` events once
//! more than `MAX_BUFFER_SIZE` are buffered.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::bridge::spawn_task;
use crate::ports::{EventBatcher, FlushCallback, BATCH_INTERVAL_MS, MAX_BUFFER_SIZE};

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Default)]
struct State {
    pending: Vec<Value>,
    scheduled: bool,
    disposed: bool,
}

pub(crate) struct Batcher {
    state: Arc<Mutex<State>>,
    flush: Arc<FlushCallback>,
}

impl Batcher {
    pub(crate) fn new(flush: FlushCallback) -> Self {
        Self { state: Arc::default(), flush: Arc::new(flush) }
    }

    fn do_flush(state: &Mutex<State>, flush: &FlushCallback) {
        let batch = {
            let mut guard = lock(state);
            guard.scheduled = false;
            if guard.pending.is_empty() || guard.disposed {
                return;
            }
            std::mem::take(&mut guard.pending)
        };
        flush(batch);
    }
}

impl EventBatcher for Batcher {
    fn push(&self, event: Value) {
        let schedule = {
            let mut state = lock(&self.state);
            if state.disposed {
                return;
            }
            if state.pending.len() >= MAX_BUFFER_SIZE && event.get("type").and_then(Value::as_str) == Some("tool_execution_update") {
                return;
            }
            state.pending.push(event);
            if state.scheduled {
                false
            } else {
                state.scheduled = true;
                true
            }
        };
        if schedule {
            let state = self.state.clone();
            let flush = self.flush.clone();
            spawn_task(async move {
                tokio::time::sleep(Duration::from_millis(BATCH_INTERVAL_MS)).await;
                Batcher::do_flush(&state, &flush);
            });
        }
    }

    fn flush_now(&self) {
        if lock(&self.state).pending.is_empty() {
            return;
        }
        Batcher::do_flush(&self.state, &self.flush);
    }

    fn dispose(&self) {
        let mut state = lock(&self.state);
        state.disposed = true;
        state.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn batcher() -> (Batcher, Arc<Mutex<Vec<Vec<Value>>>>) {
        let flushed: Arc<Mutex<Vec<Vec<Value>>>> = Arc::default();
        let log = flushed.clone();
        let batcher = Batcher::new(Box::new(move |batch| lock(&log).push(batch)));
        (batcher, flushed)
    }

    #[tokio::test(start_paused = true)]
    async fn batches_within_one_interval() {
        let (batcher, flushed) = batcher();
        batcher.push(json!({ "type": "message_start" }));
        tokio::time::sleep(Duration::from_millis(10)).await;
        batcher.push(json!({ "type": "message_update" }));
        assert!(lock(&flushed).is_empty());
        tokio::time::sleep(Duration::from_millis(BATCH_INTERVAL_MS)).await;
        tokio::task::yield_now().await;
        assert_eq!(lock(&flushed).len(), 1);
        assert_eq!(lock(&flushed)[0].len(), 2);
        batcher.push(json!({ "type": "message_end" }));
        tokio::time::sleep(Duration::from_millis(BATCH_INTERVAL_MS + 1)).await;
        tokio::task::yield_now().await;
        assert_eq!(lock(&flushed).len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn drops_oldest_beyond_the_cap() {
        let (batcher, flushed) = batcher();
        for index in 0..MAX_BUFFER_SIZE {
            batcher.push(json!({ "type": "tool_execution_update", "n": index }));
        }
        // Over the cap, intermediate tool output is dropped while the buffer is full…
        batcher.push(json!({ "type": "tool_execution_update", "n": "dropped" }));
        // …but a lifecycle event is never dropped.
        batcher.push(json!({ "type": "tool_execution_end" }));
        batcher.flush_now();
        let batches = lock(&flushed).clone();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), MAX_BUFFER_SIZE + 1);
        assert!(batches[0].iter().all(|event| event["n"] != "dropped"));
        assert_eq!(batches[0][MAX_BUFFER_SIZE]["type"], "tool_execution_end");
    }

    #[tokio::test(start_paused = true)]
    async fn dispose_drops_pending_events_and_ignores_later_pushes() {
        let (batcher, flushed) = batcher();
        batcher.push(json!({ "type": "message_start" }));
        batcher.dispose();
        batcher.push(json!({ "type": "message_end" }));
        batcher.flush_now();
        tokio::time::sleep(Duration::from_millis(BATCH_INTERVAL_MS + 1)).await;
        tokio::task::yield_now().await;
        assert!(lock(&flushed).is_empty());
    }
}
