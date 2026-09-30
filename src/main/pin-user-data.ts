/**
 * Pins the profile directory before anything reads it. This module must stay
 * the first import of index.ts: the i18n store opens at import time and the
 * single-instance lock lives in userData, and Electron caches the path on its
 * first read.
 */
import { mkdirSync } from "node:fs";
import { app } from "electron";
import { userDataDirectory } from "./user-data-directory";

const directory = userDataDirectory(app.getPath("appData"), app.commandLine.getSwitchValue("user-data-dir"));
mkdirSync(directory, { recursive: true });
app.setPath("userData", directory);
