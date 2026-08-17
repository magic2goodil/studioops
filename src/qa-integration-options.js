function qaIntegrationDefaults(config = {}) {
  return {
    ...(config?.defaults?.qaIntegration || {}),
    ...(config?.qaIntegration || {}),
  };
}

function explicitBoolean(args, enabledKey, disabledKey, fallback) {
  if (args[disabledKey]) return false;
  if (args[enabledKey]) return true;
  return fallback;
}

export function resolveQaIntegrationOptions(args = {}, config = {}) {
  const defaults = qaIntegrationDefaults(config);
  return {
    project: args.project || args.projects || defaults.projects || defaults.enabledProjects,
    task: args.task || args.tasks || args["task-id"],
    partialTasks: args["partial-tasks"],
    partialActorId: args["partial-actor-id"],
    partialReasonCode: args["partial-reason-code"],
    dryRun: Boolean(args.plan || args["dry-run"] || args.dryRun),
    force: Boolean(args.force || args.reintegrate),
    validationTimeoutMs: args["validation-timeout-ms"] || defaults.validationTimeoutMs,
    qaWorkspaceRoot: args["workspace-root"] || defaults.workspaceRoot,
    githubAppAuth: explicitBoolean(args, "github-app-auth", "no-github-app-auth", defaults.githubAppAuth),
    githubAppFallbackToLocalAuth: explicitBoolean(
      args,
      "github-app-local-fallback",
      "no-github-app-local-fallback",
      defaults.githubAppFallbackToLocalAuth,
    ),
    githubAppCredentialsDir: args["github-apps-dir"] || defaults.githubAppCredentialsDir,
    githubAppRole: args["github-app-role"] || defaults.githubAppRole,
    githubAppDefaultRole: args["github-app-default-role"] || defaults.githubAppDefaultRole,
  };
}
