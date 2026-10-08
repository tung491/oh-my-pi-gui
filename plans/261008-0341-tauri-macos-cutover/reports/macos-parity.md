# macOS parity

macOS bundle layout (Contents/MacOS/omp, Contents/Resources/assistant-pack): PASS
macOS sidecar entitlements (allow-jit, allow-unsigned-executable-memory, disable-library-validation; no audio-input): PASS
macOS app entitlements (audio-input only): PASS
macOS app signature (Identifier=vn.io.vif.saiatlas, adhoc,runtime; codesign --verify --strict --deep): PASS
macOS omp URL scheme in Info.plist: PASS
macOS pack check against the bundled re-signed sidecar: PASS
macOS first launch starts a supervised sidecar with the bundled pack: PASS
macOS bundle layout: PASS
macOS app signature: PASS
macOS app entitlements: PASS
macOS sidecar entitlements: PASS
macOS info plist: PASS
macOS pack check: PASS
macOS boots a supervised sidecar: PASS
macOS single instance per profile: PASS
macOS hard kill leaves nothing: PASS (before the macOS supervisor port; the escaped-tool case is not covered yet)
