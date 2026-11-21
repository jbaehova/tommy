import { Marked, type Token, type Tokens } from "marked";
import { blockChatMath, chatMathBlockStart, chatMathStart, inlineChatMath } from "./chat-math";
import { chatTagReferences, expandChatTagReferences } from "./chat-tag-references";

// The chat renders messages with `marked`, so a preview reads the same tokens and keeps their text.
const markdown = new Marked({
  gfm: true,
  breaks: true,
  extensions: [
    {
      name: "blockMath",
      level: "block",
      start: chatMathBlockStart,
      tokenizer(source) {
        const math = blockChatMath(source);
        if (math) return { type: "blockMath", raw: math.raw, text: math.tex };
      },
    },
    {
      name: "inlineMath",
      level: "inline",
      start: chatMathStart,
      tokenizer(source) {
        const math = inlineChatMath(source);
        if (math) return { type: "inlineMath", raw: math.raw, text: math.tex };
      },
    },
    {
      // A mention (`@[Chief](agent:chief)`) would otherwise read as a link.
      name: "chatTag",
      level: "inline",
      start: (source) => source.indexOf("@["),
      tokenizer(source) {
        const reference = chatTagReferences(source)[0];
        if (reference?.start !== 0) return undefined;
        const raw = source.slice(0, reference.end);
        // A one-line preview has no room for a block quote, so the quoted text stands in marks.
        const text = reference.kind === "quote" ? `“${reference.name}”` : expandChatTagReferences(raw);
        return { type: "chatTag", raw, text };
      },
    },
  ],
});

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** The text a reader sees in a token, without the Markdown marks. A line break becomes `lineBreak`. */
function plainText(token: Token, lineBreak = " "): string {
  switch (token.type) {
    case "space":
    case "hr":
    case "def":
    case "checkbox":
      return "";
    case "br":
      return lineBreak;
    case "html":
      return token.raw.replace(/<[^>]*>/gu, " ");
    case "list":
      return token.items.map((item: Tokens.ListItem) => plainText(item)).join(" ");
    case "blockquote":
    case "list_item":
      return (token.tokens ?? []).map((child) => plainText(child)).join(" ");
    case "table":
      return [token.header, ...token.rows].flat().map(plainTextOf).join(" ");
  }
  if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens, lineBreak);
  return "text" in token && typeof token.text === "string" ? token.text : token.raw;
}

function plainTextOf(cell: { tokens: Token[] }): string {
  return inlineText(cell.tokens);
}

/**
 * Joins inline tokens. A `*` pair inside a word, as in `2*3*4`, is arithmetic more often than
 * emphasis, so it stays as written.
 */
function inlineText(tokens: Token[], lineBreak = " "): string {
  let text = "";
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    const intraword =
      token.type === "em" &&
      token.raw.startsWith("*") &&
      (WORD_CHARACTER.test(text.at(-1) ?? "") || WORD_CHARACTER.test(next?.raw.at(0) ?? ""));
    text += intraword ? token.raw : plainText(token, lineBreak);
  }
  return text;
}

/**
 * A message as one line of plain text, for a list or sidebar preview: headings, emphasis, code,
 * quotes, links, tables and list marks are removed, mentions show their name, and the blocks are
 * joined with single spaces.
 */
export function markdownPreviewText(body: string): string {
  return markdown
    .lexer(body)
    .map((token) => plainText(token))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}
