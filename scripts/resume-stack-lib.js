/**
 * Ensure the managed MCP service and Screenpipe recorder are ready without
 * rebuilding or restarting components that are already healthy.
 */
export async function resumeStack(deps) {
  const [serviceHealthy, screenpipeHealthy] = await Promise.all([
    deps.checkService(),
    deps.checkScreenpipe()
  ]);

  deps.log('check', `MCP service: ${serviceHealthy ? 'healthy' : 'unavailable'}.`);
  deps.log('check', `Screenpipe: ${screenpipeHealthy ? 'healthy' : 'unavailable'}.`);

  const serviceTask = serviceHealthy
    ? Promise.resolve().then(() => deps.log('service', 'Reusing the healthy managed MCP service.'))
    : deps.startService().then(() => deps.log('service', 'Managed MCP service is ready.'));

  const screenpipeTask = screenpipeHealthy
    ? Promise.resolve().then(() => deps.log('capture', 'Reusing the healthy Screenpipe recorder.'))
    : deps.startRecorder()
      .then(() => deps.waitForScreenpipe())
      .then(() => deps.log('capture', 'Screenpipe recorder is ready.'));

  await Promise.all([serviceTask, screenpipeTask]);

  return {
    service: serviceHealthy ? 'reused' : 'started',
    screenpipe: screenpipeHealthy ? 'reused' : 'started'
  };
}
