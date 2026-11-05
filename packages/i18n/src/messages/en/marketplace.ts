import { defineMessages } from "../../message";

export const messages = defineMessages("marketplace", {
  // The listing: categories, rows, and the words for each kind of listing.

  // The dialog frame: title, close and tabs.

  // A plugin link.

  // The agent page.

  // The skill page, and why Try is off.

  // The Marketplace window. {name} is an agent, app or skill name. {count} is a number.

  // Agents.

  // Apps.
  // The plugin page alert when only some of its apps or skills are installed. {name} is the plugin name.
  "marketplace.app.notConnected": "Not connected",
  // The category row in the information of a password manager page: 1Password and Bitwarden.
  // The plugin page section with one row for each app, and the row text by how the app connects.
  // {name} is the app name, {field} the label of its key field, {host} "this computer" or a server name.
  // {host} is "this computer" or a server name.
  // The plugin page alert when the server refused an app's saved sign-in.

  // The catalog apps' listing text, by slug. Each English text is the catalog's own text, byte for
  // byte: a key whose English no longer matches the catalog is not used. The prompts are requests that
  // the user sends to an agent.
  // The connect form text of the catalog listings. Each English text is the catalog's own text, byte for byte.

  // Skills.

  // The Skills tab. {name} is a skill, a group or a sort name. {agents} is a list of agent names,
  // "all agents" or "4 agents". {agent} is one agent name. {state} is one or more states.

  // Results that a screen reader hears. {agents} is a list of agent names.

  // Errors. {reason} is an error message. {failures} is a list of error messages.
});
