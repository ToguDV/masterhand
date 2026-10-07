/**
 * Scratch paths for the Playwright harness. These are plain constants on
 * purpose: the config file is evaluated once per process (runner AND every
 * worker), so anything derived from the clock or the pid diverges between
 * the process that spawns the servers and the one that runs the specs.
 * Fixed paths stay identical everywhere; hermeticity comes from the
 * global setup wiping them before the run and removing them after.
 */
export const E2E_DATA_DIR = "/tmp/masterhand-e2e"
export const E2E_WORKSPACES_ROOT = "/tmp/masterhand-e2e-workspace"
export const E2E_CLOUDFLARED_DIE_FILE = "/tmp/masterhand-e2e-cloudflared-die"
