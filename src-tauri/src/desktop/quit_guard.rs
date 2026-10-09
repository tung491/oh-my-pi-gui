//! The "sessions are still working" inventory behind the quit confirmation,
//! Pure: `app_quit.rs` keeps the dialog
//! and the latch.

use std::collections::HashSet;

use crate::ports::{QuitRisk, WindowTabFact};

pub(crate) fn assess_quit_risk(facts: &[WindowTabFact]) -> QuitRisk {
    let mut working_windows = HashSet::new();
    let mut working_tabs = 0;
    for fact in facts {
        if !fact.in_flight {
            continue;
        }
        working_tabs += 1;
        working_windows.insert(fact.window_id);
    }
    QuitRisk { working_tabs, total_tabs: facts.len(), working_windows: working_windows.len() }
}

/// Idle tabs die quietly; live agent runs always ask first.
pub(crate) fn quit_needs_confirmation(risk: &QuitRisk) -> bool {
    risk.working_tabs > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::WindowId;

    fn fact(window_id: u32, tab_id: &str, in_flight: bool) -> WindowTabFact {
        WindowTabFact { window_id: WindowId(window_id), tab_id: tab_id.into(), in_flight }
    }

    #[test]
    fn counts_only_the_in_flight_tabs_and_the_windows_that_hold_them() {
        let risk = assess_quit_risk(&[fact(1, "a", true), fact(1, "b", false), fact(2, "c", true), fact(3, "d", false)]);
        assert_eq!(risk, QuitRisk { working_tabs: 2, total_tabs: 4, working_windows: 2 });
    }

    #[test]
    fn names_one_window_once_even_when_several_of_its_tabs_are_working() {
        assert_eq!(assess_quit_risk(&[fact(7, "a", true), fact(7, "b", true), fact(7, "c", true)]).working_windows, 1);
    }

    #[test]
    fn asks_only_while_work_is_in_flight() {
        assert!(!quit_needs_confirmation(&assess_quit_risk(&[])));
        assert!(!quit_needs_confirmation(&assess_quit_risk(&[fact(1, "a", false)])));
        assert!(quit_needs_confirmation(&assess_quit_risk(&[fact(1, "a", true)])));
    }
}
