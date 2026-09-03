/**
 * Select the first-run, build-recovery, or fast-resume path without requiring
 * callers to inspect local state themselves.
 */
export async function startLocalStack(deps) {
  const hasConfig = await deps.hasConfig();
  const onboardingComplete = hasConfig && await deps.hasCompletedOnboarding();
  if (!onboardingComplete) {
    deps.log('mode', hasConfig
      ? 'Configuration exists, but onboarding is incomplete; continuing onboarding.'
      : 'No application config found; entering first-time onboarding.');
    await deps.ensureFirstRunScreenpipe();
    await deps.onboard();
    return { mode: 'onboard', built: false };
  }

  let built = false;
  if (!await deps.hasBuild()) {
    deps.log('mode', 'Configuration exists but build output is missing; building once.');
    await deps.build();
    built = true;
  } else {
    deps.log('mode', 'Configuration and build output found; using fast resume.');
  }

  await deps.resume();
  return { mode: 'resume', built };
}
