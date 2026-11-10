const HOST_CONNECTOR_ENVIRONMENT_KEY = "TOMMY_WORKFLOW_CONNECTORS_JSON";

/** Host connector credentials never enter provider, tool or helper processes. */
export function childProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...environment };
  // Windows treats environment names without regard to case. Remove every spelling before the
  // explicit unset, which also wins when an SDK merges this result over its inherited environment.
  for (const key of Object.keys(child)) if (key.toUpperCase() === HOST_CONNECTOR_ENVIRONMENT_KEY) delete child[key];
  child[HOST_CONNECTOR_ENVIRONMENT_KEY] = undefined;
  return child;
}
