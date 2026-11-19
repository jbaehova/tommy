// @vitest-environment node
import { describe, expect, it } from "vitest";
import { maskEmails, telegramHtml } from "./telegram-format";

describe("Telegram HTML from agent Markdown", () => {
  it("escapes every text run and links only to http and https", () => {
    const html = telegramHtml(
      '**<b onclick="x">** `<i>` [a](javascript:alert(1)) [b](https://example.com/?q="1"&r=<2>)\n```\n</code></pre><a href="x">\n```',
    );
    expect(html).not.toMatch(/<(?!\/?(?:b|i|s|code|pre|blockquote)>|a href="https:\/\/example\.com|\/a>|code class=)/);
    expect(html).toContain('<b>&lt;b onclick="x"&gt;</b>');
    expect(html).toContain("<code>&lt;i&gt;</code>");
    expect(html).toContain("[a](javascript:alert(1))");
    expect(html).toContain('<a href="https://example.com/?q=&quot;1&quot;&amp;r=&lt;2&gt;">b</a>');
    expect(html).toContain('<pre><code>&lt;/code&gt;&lt;/pre&gt;&lt;a href="x"&gt;</code></pre>');
  });
});

describe("Email addresses in Telegram text", () => {
  it("keeps two accounts apart after redaction", () => {
    expect(maskEmails("alex.kim@example.com or jordan@example.co.kr")).toBe("al***@example.com or jo***@example.co.kr");
  });
});
