// Integration tests may panic on unexpected shapes; that is the assertion.
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! The Rust side can never drift from `src/shared/ipc-types.ts` unnoticed:
//! every channel there has exactly one owning module, and every handled
//! channel is registered with its scope.

use std::collections::{BTreeMap, BTreeSet};

use sai_atlas_lib::bridge::{Registry, Scope};
use sai_atlas_lib::{desktop, ollama, omp, services, tabs, updater};

const IPC_TYPES_TS: &str = include_str!("../../src/shared/ipc-types.ts");
const EXPECTED_CHANNEL_COUNT: usize = 94;

fn block(name: &str) -> &'static str {
    let start = IPC_TYPES_TS.find(&format!("export const {name} = {{")).unwrap_or_else(|| panic!("{name} block missing"));
    let rest = &IPC_TYPES_TS[start..];
    let end = rest.find("} as const;").unwrap_or_else(|| panic!("{name} block has no end"));
    &rest[..end]
}

/// Every channel value in `IPC_COMMANDS` and `IPC_EVENTS`.
fn typescript_channels() -> BTreeSet<String> {
    let pattern = regex::Regex::new(r#"^\s*[A-Z_]+: "([A-Za-z0-9:/_-]+)""#).unwrap();
    let mut channels = BTreeSet::new();
    for text in [block("IPC_COMMANDS"), block("IPC_EVENTS")] {
        for line in text.lines() {
            if let Some(captures) = pattern.captures(line) {
                assert!(channels.insert(captures[1].to_string()), "{} is declared twice in ipc-types.ts", &captures[1]);
            }
        }
    }
    assert_eq!(channels.len(), EXPECTED_CHANNEL_COUNT, "ipc-types.ts channel count changed; update the ownership table");
    channels
}

type Module = (&'static str, &'static [(&'static str, Scope)], &'static [&'static str], fn(&mut Registry));

fn modules() -> Vec<Module> {
    vec![
        ("omp", omp::CHANNELS, omp::EMITS, omp::register),
        ("tabs", tabs::CHANNELS, tabs::EMITS, tabs::register),
        ("desktop", desktop::CHANNELS, desktop::EMITS, desktop::register),
        ("services", services::CHANNELS, services::EMITS, services::register),
        ("ollama", ollama::CHANNELS, ollama::EMITS, ollama::register),
        ("updater", updater::CHANNELS, updater::EMITS, updater::register),
    ]
}

#[test]
fn every_channel_has_one_owner() {
    let expected = typescript_channels();
    let mut owners: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for (name, handled, emitted, _) in modules() {
        for (channel, _) in handled {
            owners.entry((*channel).to_string()).or_default().push(name);
        }
        for channel in emitted {
            owners.entry((*channel).to_string()).or_default().push(name);
        }
    }
    let duplicates: Vec<_> = owners.iter().filter(|(_, modules)| modules.len() > 1).collect();
    assert!(duplicates.is_empty(), "channels with more than one owner: {duplicates:?}");
    let owned: BTreeSet<String> = owners.keys().cloned().collect();
    let unowned: Vec<_> = expected.difference(&owned).collect();
    let unknown: Vec<_> = owned.difference(&expected).collect();
    assert!(unowned.is_empty(), "channels in ipc-types.ts without a Rust owner: {unowned:?}");
    assert!(unknown.is_empty(), "Rust channels missing from ipc-types.ts: {unknown:?}");
}

#[test]
fn every_handler_is_registered() {
    let mut registry = Registry::new();
    for (_, _, _, register) in modules() {
        register(&mut registry);
    }
    let mut handled = 0;
    for (name, channels, _, _) in modules() {
        for (channel, scope) in channels {
            handled += 1;
            assert_eq!(registry.scope_of(channel), Some(*scope), "{channel} ({name}) is not registered with its scope");
        }
    }
    assert_eq!(registry.len(), handled, "the registry holds channels no module lists");
    let quick_entry: Vec<_> = registry.channels().into_iter().filter(|c| registry.scope_of(c) == Some(Scope::QuickEntry)).collect();
    assert_eq!(quick_entry, vec!["quick-entry:consume-restored", "quick-entry:dismiss", "quick-entry:submit"]);
}
