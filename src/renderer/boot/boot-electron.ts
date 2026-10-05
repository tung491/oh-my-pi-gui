/**
 * `@boot` for the Electron build. The preload has already exposed `window.omp`
 * (or `window.ompQuickEntry`) through contextBridge before any page script
 * runs, so there is nothing to install here. The Tauri build aliases `@boot`
 * to `boot-tauri.ts` instead (see vite.tauri.config.ts).
 */
