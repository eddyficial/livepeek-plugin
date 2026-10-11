// Shared state location and one-time migration from the pre-0.5 directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STATE_DIR = path.join(os.homedir(), '.livepeek');
const LEGACY_STATE_DIR = path.join(os.homedir(), '.peek');

// Rename only when the new location is absent. State is a convenience, so a
// failed migration must never prevent livepeek from starting.
if (!fs.existsSync(STATE_DIR) && fs.existsSync(LEGACY_STATE_DIR)) {
  try { fs.renameSync(LEGACY_STATE_DIR, STATE_DIR); } catch { /* best effort */ }
}
