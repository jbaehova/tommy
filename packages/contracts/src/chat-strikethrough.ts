/**
 * Only `~~` strikes text. A Markdown renderer with GFM on also strikes on one `~`, so a range such as
 * `09:00~18:00 ... 11:00~20:00` loses its marks and shows as struck text.
 */
export const CHAT_STRIKETHROUGH = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?!~)/;
