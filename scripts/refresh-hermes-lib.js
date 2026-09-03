/**
 * Rebuild the current source, restart the managed MCP service, restore the
 * shared local stack, and prove that Hermes can call the refreshed service.
 */
export async function refreshHermes(deps) {
  deps.log('build', 'Building the current source.');
  await deps.build();

  deps.log('service', 'Reinstalling and restarting the managed MCP service.');
  await deps.restartService();

  deps.log('stack', 'Checking the managed service and shared Screenpipe recorder.');
  await deps.resumeStack();

  if (deps.syncHermesConfig) {
    deps.log('config', 'Syncing Hermes tools.include with current tool set.');
    await deps.syncHermesConfig();
  }

  deps.log('hermes', 'Running the real Hermes MCP tool-call verification.');
  await deps.verifyHermes();

  return { refreshed: true, verified: true };
}
