export const IMAGE_ATTACHMENT_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif"] as const;

export const MEDIA_ATTACHMENT_EXTENSIONS = ["mp3", "mov"] as const;

export const ARCHIVE_ATTACHMENT_EXTENSIONS = ["zip"] as const;

/** MP4 came after `media-attachments`, so a remote host advertises it with its own capability. */
export const MP4_ATTACHMENT_EXTENSIONS = ["mp4"] as const;

/**
 * SVG came after the other types, so a remote host advertises it with its own capability. An SVG is
 * a `file` attachment, not an `image` one: providers take only raster image blocks, so the agent gets
 * the path and reads the SVG text.
 */
export const SVG_ATTACHMENT_EXTENSIONS = ["svg"] as const;

export const CONTEXT_ATTACHMENT_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "odt",
  "rtf",
  "xls",
  "xlsx",
  "ods",
  "ppt",
  "pptx",
  "odp",
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "jsonl",
  "log",
  "xml",
  "yaml",
  "yml",
  "bash",
  "c",
  "cc",
  "conf",
  "cpp",
  "cs",
  "css",
  "cts",
  "env",
  "eml",
  "fish",
  "go",
  "gradle",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "ipynb",
  "java",
  "js",
  "jsx",
  "kt",
  "kts",
  "lock",
  "mjs",
  "mts",
  "php",
  "properties",
  "ps1",
  "py",
  "rb",
  "rs",
  "scala",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "tex",
  "vue",
  "zsh",
] as const;

export const ATTACHMENT_FILE_EXTENSIONS = [
  ...IMAGE_ATTACHMENT_EXTENSIONS,
  ...MEDIA_ATTACHMENT_EXTENSIONS,
  ...ARCHIVE_ATTACHMENT_EXTENSIONS,
  ...MP4_ATTACHMENT_EXTENSIONS,
  ...SVG_ATTACHMENT_EXTENSIONS,
  ...CONTEXT_ATTACHMENT_EXTENSIONS,
] as const;

export const SUPPORTED_ATTACHMENT_DESCRIPTION =
  "images, MP3 audio, MOV or MP4 video, ZIP archives, PDF, Office documents, EML, text, Markdown, data, or source files";

export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const SUPPORTED_EXTENSIONS = new Set<string>(ATTACHMENT_FILE_EXTENSIONS);
const EXTENSIONLESS_TEXT_FILES = new Set(["dockerfile", "makefile", "procfile"]);

export function attachmentFileExtension(name: string): string | null {
  const basename = name.split(/[\\/]/u).at(-1)?.trim().toLowerCase() ?? "";
  const dot = basename.lastIndexOf(".");
  return dot >= 0 && dot < basename.length - 1 ? basename.slice(dot + 1) : null;
}

export function isSupportedAttachmentName(name: string): boolean {
  const basename = name.split(/[\\/]/u).at(-1)?.trim().toLowerCase() ?? "";
  const extension = attachmentFileExtension(basename);
  return EXTENSIONLESS_TEXT_FILES.has(basename) || (extension !== null && SUPPORTED_EXTENSIONS.has(extension));
}

/**
 * The one rejection message for an unsupported attachment. Both import paths throw it: the renderer
 * drop and file-picker handlers in `src/main/ipc/attachment-handlers.ts`, and the draft and transfer
 * operations in `src/backend/attachment-files.ts`. A user must not read two different sentences for
 * the same refused file.
 */
export function assertSupportedAttachmentName(name: string): void {
  if (isSupportedAttachmentName(name)) return;
  throw new Error(
    `${name} is not supported. Attach ${SUPPORTED_ATTACHMENT_DESCRIPTION}. For other audio or video formats, export as MP3, MOV, or MP4, or attach a text transcript.`,
  );
}

export function attachmentMimeTypeForName(name: string) {
  switch (attachmentFileExtension(name)) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "mp3":
      return "audio/mpeg";
    case "mov":
      return "video/quicktime";
    case "mp4":
      return "video/mp4";
    case "zip":
      return "application/zip";
    case "pdf":
      return "application/pdf";
    // An SVG attachment keeps this type for its preview, but it is a `file` attachment, not an
    // `image` one (see `SVG_ATTACHMENT_EXTENSIONS`).
    case "svg":
      return "image/svg+xml";
    case "eml":
      return "message/rfc822";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "odt":
      return "application/vnd.oasis.opendocument.text";
    case "rtf":
      return "application/rtf";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return XLSX_MIME_TYPE;
    case "ods":
      return "application/vnd.oasis.opendocument.spreadsheet";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "odp":
      return "application/vnd.oasis.opendocument.presentation";
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
    case "jsonl":
    case "ipynb":
      return "application/json";
    default:
      return isSupportedAttachmentName(name) ? "text/plain" : "application/octet-stream";
  }
}

/**
 * The media kinds a browser can play. Attachments keep `previewKind: "none"` on the wire, because
 * the released Team API v1-v4 validators accept only image, pdf, text, and none. The renderer reads
 * the MIME type instead, which is already a free string in those protocols.
 */
export function playableMediaKind(mimeType: string): "audio" | "video" | null {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}
