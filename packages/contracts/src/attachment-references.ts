export interface AttachmentReference {
  attachmentId: string;
  name: string;
  start: number;
  end: number;
  marker: string;
}

const ATTACHMENT_REFERENCE_PATTERN = /@\[([^\x5d\r\n]+)\]\(attachment:([^)\r\n]+)\)/gu;

export function serializeAttachmentReference(name: string, attachmentId: string): string {
  const safeName = name.replace(/[\x5d\r\n]+/gu, " ").trim() || "file";
  const safeId = attachmentId.replace(/[)\r\n]+/gu, "").trim();
  return `@[${safeName}](attachment:${safeId})`;
}

export function rewriteAttachmentReferences(
  value: string,
  resolve: (reference: AttachmentReference) => { attachmentId: string; name: string } | null | undefined,
): string {
  return value.replace(
    ATTACHMENT_REFERENCE_PATTERN,
    (marker: string, name: string, attachmentId: string, offset: number) => {
      const resolved = resolve({
        attachmentId,
        name,
        start: offset,
        end: offset + marker.length,
        marker,
      });
      return resolved ? serializeAttachmentReference(resolved.name, resolved.attachmentId) : name;
    },
  );
}

export function expandAttachmentReferences(
  value: string,
  resolveName?: (reference: AttachmentReference) => string | null | undefined,
): string {
  return value.replace(
    ATTACHMENT_REFERENCE_PATTERN,
    (marker: string, name: string, attachmentId: string, offset: number) =>
      resolveName?.({
        attachmentId,
        name,
        start: offset,
        end: offset + marker.length,
        marker,
      }) ?? name,
  );
}
