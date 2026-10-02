fn main() {
    // The bridge commands are declared here so the capability files can grant
    // exactly `allow-omp-invoke`, `allow-omp-quick-entry-invoke` and `allow-omp-attach`.
    let manifest = tauri_build::AppManifest::new().commands(&["omp_invoke", "omp_quick_entry_invoke", "omp_attach"]);
    if let Err(error) = tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)) {
        panic!("tauri build failed: {error}");
    }
}
