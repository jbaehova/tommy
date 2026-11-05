import { defineMessages } from "../../message";

/**
 * The public web pages that do one task: join a server, return from Slack or Discord, return from
 * billing, report a hosted site, and the load error page. `apps/auth-api` renders
 * them on the server in the visitor's language.
 */
export const messages = defineMessages("sitePage", {
  // {browser} and {download} are links. Their text is browserLink and downloadLink.
  // {open} is the label of the button that did not open Tommy.
  // {open} is the label of the button above this note.
  // {name} is Slack or Discord on all the connect keys.
  // {marketplace}, {apps} and {connect} are the names of these screens and that button in the app.
  // {email} is the contact address. The page shows it as a link.
  // {count} is the largest number of members that the page sells, such as 25.
  // The public Marketplace. The tab and category names are the app's `marketplace.*` keys.
  // {name} is the name of an agent or a skill.
  // The text of the share image for screen readers. {creator} is the name of the person who made it.
  // {name} is the name of the person who made the agent or the skill.
  // A screen reader reads this after the name of a verified agent or skill.
  // A screen reader reads this when a search or a category changes the list.
  // {query} is the text in the search field.
  // Shows after "Add to Tommy" did not open the app.
  // {platform} is macOS, Windows or Linux.
  // {version} is a number, such as 3.
  // A routine that the agent brings switched off. It runs only after the user switches it on.
});
