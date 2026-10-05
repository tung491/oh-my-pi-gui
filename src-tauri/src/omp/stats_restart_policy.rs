//! Restart budget for the bundled stats server, ported from
//! `src/main/stats-restart-policy.ts`. A crash cycle gets a bounded backoff
//! ladder, and a server that already gave up can be revived on demand by the
//! next dashboard read, for a capped number of rounds, after which the failure
//! is reported instead of retried forever.

pub(crate) const MAX_RESTART_ATTEMPTS: u32 = 3;
const RESTART_DELAYS_MS: [u64; 3] = [1000, 2000, 4000];
/// Minimum gap between two demand-driven revive rounds.
const REVIVE_COOLDOWN_MS: u64 = 30_000;
/// Revive rounds allowed since the last successful bind.
const MAX_REVIVE_ROUNDS: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Revive {
    Scheduled,
    AlreadyPending,
    Exhausted,
}

#[derive(Debug, Default)]
pub(crate) struct RestartBudget {
    attempt: u32,
    revive_rounds: u32,
    last_revive_at: Option<u64>,
}

impl RestartBudget {
    /// Delay before the next restart of this crash cycle, or `None` once the
    /// cycle is spent. Consumes a slot: calling it again advances the ladder.
    pub(crate) fn next_delay(&mut self) -> Option<u64> {
        if self.attempt >= MAX_RESTART_ATTEMPTS {
            return None;
        }
        let delay = RESTART_DELAYS_MS.get(self.attempt as usize).copied().unwrap_or(4000);
        self.attempt += 1;
        Some(delay)
    }

    /// A read asked for the server after it had given up. The cooldown bounds
    /// how often a broken binary is re-spawned; the round cap is what lets the
    /// caller surface a dead end instead of retrying for the session's life.
    pub(crate) fn revive(&mut self, now_ms: u64) -> Revive {
        if self.revive_rounds >= MAX_REVIVE_ROUNDS {
            return Revive::Exhausted;
        }
        if let Some(last) = self.last_revive_at {
            if now_ms.saturating_sub(last) < REVIVE_COOLDOWN_MS {
                return Revive::AlreadyPending;
            }
        }
        self.revive_rounds += 1;
        self.last_revive_at = Some(now_ms);
        self.attempt = 0;
        Revive::Scheduled
    }

    /// The server bound its port: both budgets start over.
    pub(crate) fn note_ready(&mut self) {
        self.attempt = 0;
        self.revive_rounds = 0;
        self.last_revive_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COOLDOWN_MS: u64 = 30_000;

    #[test]
    fn caps_one_crash_cycle_and_then_stops_asking_for_a_respawn() {
        let mut budget = RestartBudget::default();
        let delays: Vec<Option<u64>> = (0..MAX_RESTART_ATTEMPTS + 2).map(|_| budget.next_delay()).collect();
        assert_eq!(delays[..MAX_RESTART_ATTEMPTS as usize], [Some(1000), Some(2000), Some(4000)]);
        assert_eq!(delays[MAX_RESTART_ATTEMPTS as usize..], [None, None]);
    }

    #[test]
    fn treats_a_successful_bind_as_proof_the_crash_cycle_was_not_systemic() {
        let mut budget = RestartBudget::default();
        assert_eq!(budget.next_delay(), Some(1000));
        assert_eq!(budget.next_delay(), Some(2000));
        budget.note_ready();
        // A server that ran fine and died later gets the full ladder again.
        assert_eq!(budget.next_delay(), Some(1000));
    }

    #[test]
    fn revives_a_given_up_server_on_demand_but_not_once_per_read() {
        let mut budget = RestartBudget::default();
        for _ in 0..MAX_RESTART_ATTEMPTS {
            assert!(budget.next_delay().is_some());
        }
        assert_eq!(budget.revive(1_000), Revive::Scheduled);
        // The dashboard polls every couple of seconds while starting; each poll
        // must not queue another spawn.
        assert_eq!(budget.revive(1_000 + COOLDOWN_MS / 2), Revive::AlreadyPending);
        assert_eq!(budget.revive(1_000 + COOLDOWN_MS), Revive::Scheduled);
    }

    #[test]
    fn stops_reviving_so_the_failure_reaches_the_user() {
        let mut budget = RestartBudget::default();
        let verdicts: Vec<Revive> = (0..6).map(|round| budget.revive(round * COOLDOWN_MS)).collect();
        assert_eq!(verdicts.iter().filter(|verdict| **verdict == Revive::Scheduled).count(), 3);
        assert_eq!(verdicts[3..], [Revive::Exhausted, Revive::Exhausted, Revive::Exhausted]);
    }

    #[test]
    fn gives_a_revived_server_its_own_crash_cycle() {
        let mut budget = RestartBudget::default();
        for _ in 0..MAX_RESTART_ATTEMPTS {
            budget.next_delay();
        }
        assert_eq!(budget.next_delay(), None);
        assert_eq!(budget.revive(0), Revive::Scheduled);
        assert_eq!(budget.next_delay(), Some(1000));
    }

    #[test]
    fn keeps_reviving_forever_out_of_the_picture_once_it_recovers() {
        let mut budget = RestartBudget::default();
        assert_eq!(budget.revive(0), Revive::Scheduled);
        assert_eq!(budget.revive(COOLDOWN_MS), Revive::Scheduled);
        budget.note_ready();
        assert_eq!(budget.revive(COOLDOWN_MS * 2), Revive::Scheduled);
    }
}
