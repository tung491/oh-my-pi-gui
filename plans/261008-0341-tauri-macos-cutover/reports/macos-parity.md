# macOS parity

macOS bundle layout (Contents/MacOS/omp, Contents/Resources/assistant-pack): PASS
macOS sidecar entitlements (allow-jit, allow-unsigned-executable-memory, disable-library-validation; no audio-input): PASS
macOS app entitlements (audio-input only): PASS
macOS app signature (Identifier=vn.io.vif.saiatlas, adhoc,runtime; codesign --verify --strict --deep): PASS
macOS omp URL scheme in Info.plist: PASS
macOS pack check against the bundled re-signed sidecar: PASS
macOS first launch starts a supervised sidecar with the bundled pack: PASS
