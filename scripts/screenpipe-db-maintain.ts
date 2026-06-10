import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createAxTreeMaintenanceService } from '../src/services/maintenance/ax-tree-maintenance-service.js';
import { runVacuumInit } from '../src/services/maintenance/vacuum-init.js';

const DB_PATH = process.env.SCREENPIPE_DB_PATH ?? join(homedir(), '.screenpipe', 'db.sqlite');
const BACKUP_DIR = join(homedir(), '.screenpipe', 'backup');

function probeScreenpipeRunning(): boolean {
  try {
    execFileSync('pgrep', ['-f', 'screenpipe.*record'], { stdio: 'pipe' });
    return true;
  } catch {
    // no pgrep match
  }
  try {
    execFileSync('curl', ['-s', '--max-time', '2', '-o', '/dev/null', 'http://127.0.0.1:3030/health'], {
      stdio: 'pipe'
    });
    return true;
  } catch {
    return false;
  }
}

const command = process.argv[2];
const service = createAxTreeMaintenanceService({ databasePath: DB_PATH, logger: console });

switch (command) {
  case 'init': {
    const result = runVacuumInit({ databasePath: DB_PATH, backupDir: BACKUP_DIR, probeScreenpipeRunning });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  case 'run': {
    const sweep = service.sweepOnce();
    const reclaim = service.reclaimOnce({});
    console.log(JSON.stringify({ sweep, reclaim }, null, 2));
    process.exit(0);
  }
  case 'status': {
    console.log(JSON.stringify(service.status(), null, 2));
    process.exit(0);
  }
  default: {
    console.error('Usage: screenpipe-db-maintain <init|run|status>');
    process.exit(2);
  }
}
