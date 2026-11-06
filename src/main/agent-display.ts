/**
 * The X display the agents work on, when it is not the display Tommy shows its windows on.
 *
 * The server scripts name it in `TOMMY_AGENT_DISPLAY`: the boat desktop on a hosted server, else a
 * second virtual display. Tommy keeps its own `DISPLAY`, because its built-in browser draws its
 * tabs in the Tommy window. The Computer Use driver and the agent processes get the agent display,
 * so an agent's screenshot does not show Tommy, and a program an agent starts opens where the driver
 * can see it.
 *
 * The agent processes also ask for accessibility. A bare server session has no settings daemon, so a
 * Chromium, Electron, Qt or GTK 4 app registers on the AT-SPI bus only when its environment asks. Tommy
 * itself never gets these variables: it shares the session bus with the agents, and an app that does
 * not ask stays off the tree that the driver reads, whatever display it is on.
 *
 * On a computer with a person at it, nothing sets the variable and everything shares one display.
 */
export function agentDisplayEnvironment(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const display = platform === "linux" ? environment.TOMMY_AGENT_DISPLAY : undefined;
  return display ? { DISPLAY: display, ACCESSIBILITY_ENABLED: "1", QT_ACCESSIBILITY: "1", GTK_A11Y: "atspi" } : {};
}

/** Whether the agents have a display of their own, which Tommy's windows are not on. */
export function hasSeparateAgentDisplay(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv = process.env) {
  return "DISPLAY" in agentDisplayEnvironment(platform, environment);
}
