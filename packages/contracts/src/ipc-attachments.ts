import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString, isIdentifier, isNullableBoundedString } from "./ipc-bounded-values";
import { guardedDecoder } from "./ipc-decoding";
import { isBoolean, isDynamicRecord, isNumber, isOneOf } from "./runtime-values";

export type AttachmentKind = "image" | "file";
export type AttachmentPreviewKind = "image" | "pdf" | "text" | "none";

export interface AttachmentSummary {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  mimeType: string;
  previewKind: AttachmentPreviewKind;
  previewUrl: string | null;
}

export function isAttachmentSummary(value: unknown): value is AttachmentSummary {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.attachmentName) &&
    isNumber(value.size) &&
    value.size >= 0 &&
    isOneOf(["image", "file"] as const, value.kind) &&
    isBoundedString(value.mimeType, INPUT_LIMITS.mimeType) &&
    isOneOf(["image", "pdf", "text", "none"] as const, value.previewKind) &&
    (value.previewUrl === null || isBoundedString(value.previewUrl, INPUT_LIMITS.avatarUrl))
  );
}

export type DraftAttachment = AttachmentSummary;

export interface AttachmentDataInput {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** The most entries one folder view shows. The rest are counted by `truncated`. */
export const WORKSPACE_DIRECTORY_LIMIT = 500;

export interface WorkspaceDirectoryEntry {
  name: string;
  /** A path the workspace file and folder requests accept again. */
  path: string;
  kind: "file" | "directory";
  /** Bytes for a file, 0 for a folder. */
  size: number;
  /** Milliseconds since the epoch. */
  modifiedAt: number;
}

export interface WorkspaceDirectory {
  name: string;
  path: string;
  /** The agent's workspace root, as the agent summary names it. */
  root: string;
  /** The folder above, or null at the workspace root. */
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
  truncated: boolean;
}

const WORKSPACE_DIRECTORY_ENTRY_KINDS = ["file", "directory"] as const;

function isWorkspaceDirectoryEntry(value: unknown): value is WorkspaceDirectoryEntry {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.name, 1_024) &&
    isBoundedString(value.path, INPUT_LIMITS.path) &&
    isOneOf(WORKSPACE_DIRECTORY_ENTRY_KINDS, value.kind) &&
    isNumber(value.size) &&
    isNumber(value.modifiedAt)
  );
}

/** The folder a host or the main process answers, checked where it enters the renderer or the client. */
export function isWorkspaceDirectory(value: unknown): value is WorkspaceDirectory {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.name, 1_024) &&
    isBoundedString(value.path, INPUT_LIMITS.path) &&
    isBoundedString(value.root, INPUT_LIMITS.path) &&
    isNullableBoundedString(value.parentPath, INPUT_LIMITS.path) &&
    Array.isArray(value.entries) &&
    value.entries.length <= WORKSPACE_DIRECTORY_LIMIT &&
    value.entries.every(isWorkspaceDirectoryEntry) &&
    isBoolean(value.truncated)
  );
}

/** The same check at the preload and the remote host client: the shape has one producer. */
export const decodeWorkspaceDirectory = guardedDecoder(isWorkspaceDirectory, "workspace directory");
