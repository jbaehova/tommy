/**
 * Converts the Markdown that agents write to the HTML subset that Telegram renders. Every text
 * run is escaped, and only http and https links become anchors, so agent text cannot add markup.
 */

export function escapeTelegramHtml(text: string): string {
  return escapeHtml(text);
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

/** Inline Markdown in one line of text that is not code. */
function inline(text: string): string {
  const parts: string[] = [];
  // Inline code first, so that its content is never styled.
  const pattern = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(styled(text.slice(last, match.index)));
    parts.push(`<code>${escapeHtml(match[2] ?? "")}</code>`);
    last = match.index + match[0].length;
  }
  parts.push(styled(text.slice(last)));
  return parts.join("");
}

function styled(text: string): string {
  const links: string[] = [];
  // Links become placeholders, so their URLs are not styled.
  let value = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => {
    links.push(`<a href="${escapeAttribute(url)}">${styledText(escapeHtml(label))}</a>`);
    return `\uE000${links.length - 1}\uE000`;
  });
  value = styledText(escapeHtml(value));
  return value.replace(/\uE000(\d+)\uE000/g, (_, index: string) => links[Number(index)] ?? "");
}

function styledText(text: string): string {
  return text
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<b>$2</b>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<s>$1</s>")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<i>$2</i>");
}

const tableRow = /^\s*\|.*\|\s*$/;

export function telegramHtml(markdown: string): string {
  const lines = markdown.replaceAll("\uE000", "").replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index++;
      }
      index++;
      const language = fence[2] ? ` class="language-${escapeAttribute(fence[2])}"` : "";
      out.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (tableRow.test(line)) {
      const rows: string[] = [];
      while (index < lines.length && tableRow.test(lines[index] ?? "")) {
        rows.push(lines[index] ?? "");
        index++;
      }
      out.push(`<pre>${escapeHtml(rows.join("\n"))}</pre>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
        quote.push(inline((lines[index] ?? "").replace(/^\s*>\s?/, "")));
        index++;
      }
      out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) out.push(`<b>${inline(heading[1] ?? "")}</b>`);
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) out.push("──────────");
    else {
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bullet) out.push(`${bullet[1] ?? ""}• ${inline(bullet[2] ?? "")}`);
      else out.push(inline(line));
    }
    index++;
  }
  return out.join("\n");
}

/**
 * Outgoing text redaction removes whole email addresses, so a choice between two accounts would
 * show the same placeholder twice. Show enough of each address to tell them apart.
 */
export function maskEmails(text: string): string {
  return text.replace(
    /([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g,
    "$1***@$2",
  );
}
