import { createHash } from "node:crypto";
import type { WorkflowGitHubCatalog, WorkflowGitHubEvent, WorkflowGitHubRepositoryOptions } from "@tommy/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@tommy/contracts/runtime-values";
import { sourceText } from "@tommy/i18n/source";
import { redactText } from "@tommy/logging";
import { Effect } from "effect";
import type {
  WorkflowGitHubApi,
  WorkflowGitHubChange,
  WorkflowGitHubChangeResult,
  WorkflowGitHubFile,
} from "../backend/workflows/workflow-github-api";
import type { GitHubWorkflowConnection } from "./workflow-connector-config";
import type { ConnectorJson, WorkflowConnectorHttp, WorkflowConnectorHttpFailure } from "./workflow-connector-http";

const API_ORIGIN = "https://api.github.com";
const FILE_BRANCH = "tommy-workflow-files";
const FILE_LIMIT = 3 * 1_024 * 1_024;
const PUBLIC_FILE_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net", "raw.githubusercontent.com"]);

function record(value: ConnectorJson | undefined): DynamicRecord | null {
  return isDynamicRecord(value) ? value : null;
}

function records(value: ConnectorJson): DynamicRecord[] {
  return Array.isArray(value) ? value.filter(isDynamicRecord) : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Credentials stay in the main process. Every repository must be explicitly allowlisted. */
export class WorkflowConnectorGitHub implements WorkflowGitHubApi {
  readonly #connection: GitHubWorkflowConnection;
  readonly #http: WorkflowConnectorHttp;
  readonly #webhookUrl: string | null;

  constructor(
    connection: GitHubWorkflowConnection,
    http: WorkflowConnectorHttp,
    publicWebhookOrigin: string | null = null,
  ) {
    this.#connection = connection;
    this.#http = http;
    this.#webhookUrl = publicWebhookOrigin ? `${publicWebhookOrigin}/hooks/github` : null;
  }

  allows(repository: string): boolean {
    return this.#connection.repositories.some((allowed) => allowed.toLowerCase() === repository.toLowerCase());
  }

  readonly catalog = Effect.fn("WorkflowConnectorGitHub.catalog")(function* (this: WorkflowConnectorGitHub) {
    const repositories = yield* Effect.forEach(
      this.#connection.repositories,
      (repository) =>
        Effect.gen({ self: this }, function* () {
          const details = record(yield* this.#request(repository, ""));
          if (!details || typeof details.full_name !== "string" || typeof details.private !== "boolean")
            return yield* Effect.fail({
              code: "unreachable" as const,
              message: sourceText("error.workflow.githubUncertain"),
            });
          const permissions = isDynamicRecord(details.permissions) ? details.permissions : null;
          let events = false;
          if (this.#webhookUrl) {
            const hooks = yield* Effect.result(this.#request(repository, "/hooks?per_page=100"));
            // App installation hooks cannot be inspected through the repository hook API. Do not assert them.
            if (hooks._tag === "Success")
              events = records(hooks.success).some(
                (hook) =>
                  hook.active === true &&
                  isDynamicRecord(hook.config) &&
                  hook.config.url === this.#webhookUrl &&
                  Array.isArray(hook.events) &&
                  (hook.events.includes("*") ||
                    [
                      "issues",
                      "issue_comment",
                      "pull_request",
                      "pull_request_review",
                      "pull_request_review_comment",
                      "check_suite",
                    ].every((event) => Array.isArray(hook.events) && hook.events.includes(event))),
              );
          }
          return {
            fullName: repository,
            private: details.private,
            canWrite: permissions?.push === true || permissions?.maintain === true || permissions?.admin === true,
            events,
          };
        }),
      { concurrency: 4 },
    );
    repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
    return { connected: true, repositories } satisfies WorkflowGitHubCatalog;
  }).bind(this);

  #failure(error: WorkflowConnectorHttpFailure): {
    code: "noAccess" | "noWrite" | "invalid" | "locked" | "unreachable";
    message: string;
  } {
    const code =
      error.status === 401 || error.status === 404
        ? "noAccess"
        : error.status === 403
          ? "noWrite"
          : error.status === 422 || error.status === 400
            ? "invalid"
            : error.status === 423
              ? "locked"
              : "unreachable";
    return {
      code,
      message: sourceText(code === "unreachable" ? "error.workflow.githubUncertain" : "error.workflow.outputRefused"),
    };
  }

  #request(
    repository: string,
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" = "GET",
    body?: ConnectorJson,
  ) {
    if (!this.allows(repository))
      return Effect.fail({ code: "noAccess" as const, message: sourceText("error.workflow.outputRefused") });
    const repositoryPath = repository.split("/").map(encodeURIComponent).join("/");
    return this.#http
      .json({
        url: `${API_ORIGIN}/repos/${repositoryPath}${path}`,
        method,
        headers: {
          Authorization: `Bearer ${this.#connection.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Tommy",
        },
        ...(body === undefined ? {} : { body }),
      })
      .pipe(Effect.mapError((error) => this.#failure(error)));
  }

  readonly change = Effect.fn("WorkflowConnectorGitHub.change")(function* (
    this: WorkflowConnectorGitHub,
    change: WorkflowGitHubChange,
  ) {
    const { repository, number, action } = change;
    // Labels and account names are identifiers. Redacting them could act on a different target,
    // so refuse a secret-bearing identifier before any part of the change is sent.
    const identifiers =
      action === "issue.create"
        ? [...change.labels, ...change.people]
        : action === "label.add" || action === "label.remove"
          ? change.labels
          : action === "assign" || action === "review.request"
            ? change.people
            : [];
    if (identifiers.some((value) => redactText(value) !== value))
      return yield* Effect.fail({ code: "invalid" as const, message: sourceText("error.workflow.outputRefused") });
    if (action !== "issue.create" && (!Number.isSafeInteger(number) || number === null || number < 1))
      return yield* Effect.fail({ code: "invalid" as const, message: sourceText("error.workflow.githubItemMissing") });
    const item = `/issues/${number}`;
    let result: ConnectorJson = null;
    switch (action) {
      case "issue.create":
        result = yield* this.#request(repository, "/issues", "POST", {
          title: redactText(change.title),
          body: redactText(change.body),
          labels: change.labels,
          assignees: change.people,
        });
        break;
      case "comment":
        result = yield* this.#request(repository, `${item}/comments`, "POST", { body: redactText(change.body) });
        break;
      case "label.add":
        result = yield* this.#request(repository, `${item}/labels`, "POST", { labels: change.labels });
        break;
      case "label.remove":
        for (const label of change.labels)
          yield* this.#request(repository, `${item}/labels/${encodeURIComponent(label)}`, "DELETE");
        break;
      case "assign":
        result = yield* this.#request(repository, `${item}/assignees`, "POST", { assignees: change.people });
        break;
      case "review.request":
        result = yield* this.#request(repository, `/pulls/${number}/requested_reviewers`, "POST", {
          reviewers: change.people,
        });
        break;
      case "review.approve":
      case "review.changes":
        result = yield* this.#request(repository, `/pulls/${number}/reviews`, "POST", {
          body: redactText(change.body),
          event: action === "review.approve" ? "APPROVE" : "REQUEST_CHANGES",
        });
        break;
      case "close":
      case "reopen":
        result = yield* this.#request(repository, item, "PATCH", {
          state: action === "close" ? "closed" : "open",
          ...(action === "close" ? { state_reason: change.reason === "notPlanned" ? "not_planned" : "completed" } : {}),
        });
        break;
    }
    const value = record(result);
    let created: WorkflowGitHubChangeResult["created"] = null;
    if (action === "issue.create" && typeof value?.number === "number")
      created = { kind: "issue", number: value.number };
    else if (action === "comment" && typeof value?.id === "number") created = { kind: "comment", id: value.id };
    else if ((action === "review.approve" || action === "review.changes") && typeof value?.id === "number")
      created = { kind: "review", id: value.id };
    if (
      (action === "issue.create" ||
        action === "comment" ||
        action === "review.approve" ||
        action === "review.changes") &&
      !created
    )
      return yield* Effect.fail({
        code: "unreachable" as const,
        message: sourceText("error.workflow.githubUncertain"),
      });
    let url: string | null = null;
    if (typeof value?.html_url === "string") {
      try {
        const parsed = new URL(value.html_url);
        if (parsed.protocol === "https:" && parsed.hostname === "github.com" && !parsed.username && !parsed.password)
          url = parsed.href;
      } catch {
        // A malformed response URL does not turn a completed write into a retry.
      }
    }
    return { created, url };
  }).bind(this);

  readonly options = Effect.fn("WorkflowConnectorGitHub.options")(function* (
    this: WorkflowConnectorGitHub,
    repository: string,
  ) {
    const result: WorkflowGitHubRepositoryOptions = { labels: [], people: [] };
    for (let page = 1; page <= 5; page += 1) {
      const labels = records(yield* this.#request(repository, `/labels?per_page=100&page=${page}`));
      result.labels.push(
        ...labels.flatMap((label) =>
          typeof label.name === "string" && typeof label.color === "string" && /^[a-fA-F0-9]{6}$/.test(label.color)
            ? [{ name: label.name, color: label.color }]
            : [],
        ),
      );
      if (labels.length < 100) break;
    }
    for (let page = 1; page <= 5; page += 1) {
      const people = records(yield* this.#request(repository, `/assignees?per_page=100&page=${page}`));
      result.people.push(...people.flatMap((person) => (typeof person.login === "string" ? [person.login] : [])));
      if (people.length < 100) break;
    }
    return result;
  }).bind(this);

  /** The latest API events plus current-item snapshots support manual trigger checks without a relay. */
  readonly recentEvents = Effect.fn("WorkflowConnectorGitHub.recentEvents")(function* (
    this: WorkflowConnectorGitHub,
    repository: string,
    event: WorkflowGitHubEvent,
  ) {
    const result: { event: string; body: DynamicRecord }[] = [];
    const names: Readonly<Record<string, string>> = {
      IssuesEvent: "issues",
      IssueCommentEvent: "issue_comment",
      PullRequestEvent: "pull_request",
      PullRequestReviewEvent: "pull_request_review",
      PullRequestReviewCommentEvent: "pull_request_review_comment",
    };
    for (const entry of records(yield* this.#request(repository, "/events?per_page=100"))) {
      const name = names[string(entry.type)];
      if (!name || !isDynamicRecord(entry.payload) || !isDynamicRecord(entry.actor)) continue;
      result.push({
        event: name,
        body: { ...entry.payload, sender: entry.actor, repository: { full_name: repository } },
      });
    }
    // The events endpoint can lag. Snapshots also include repositories with no recent public events.
    const pullRequest = event.startsWith("pr.");
    const items = records(
      yield* this.#request(
        repository,
        pullRequest
          ? "/pulls?state=all&sort=updated&direction=desc&per_page=10"
          : "/issues?state=all&sort=updated&direction=desc&per_page=10",
      ),
    );
    for (const item of items) {
      if (!isDynamicRecord(item.user)) continue;
      const subject = { ...item, merged: item.merged_at !== null && item.merged_at !== undefined };
      const body = { repository: { full_name: repository }, sender: item.user };
      if (event === "comment" || event === "mention") {
        if (typeof item.number === "number") {
          for (const comment of records(
            yield* this.#request(repository, `/issues/${item.number}/comments?per_page=10`),
          )) {
            if (isDynamicRecord(comment.user))
              result.push({
                event: "issue_comment",
                body: {
                  ...body,
                  sender: comment.user,
                  action: "created",
                  issue: item,
                  comment,
                },
              });
          }
        }
      }
      if (event === "pr.reviewSubmitted" && typeof item.number === "number") {
        for (const review of records(yield* this.#request(repository, `/pulls/${item.number}/reviews?per_page=10`))) {
          if (isDynamicRecord(review.user))
            result.push({
              event: "pull_request_review",
              body: {
                ...body,
                sender: review.user,
                action: "submitted",
                pull_request: subject,
                review,
              },
            });
        }
      }
      if (event === "pr.checksFailed" && isDynamicRecord(item.head) && typeof item.head.sha === "string") {
        const checks = record(
          yield* this.#request(repository, `/commits/${encodeURIComponent(item.head.sha)}/check-suites?per_page=30`),
        );
        if (Array.isArray(checks?.check_suites)) {
          for (const check of checks.check_suites.filter(isDynamicRecord))
            result.push({
              event: "check_suite",
              body: {
                ...body,
                action: "completed",
                check_suite: { ...check, pull_requests: [subject] },
              },
            });
        }
      }
      const labels = Array.isArray(item.labels) ? item.labels.filter(isDynamicRecord) : [];
      const assignees = Array.isArray(item.assignees) ? item.assignees.filter(isDynamicRecord) : [];
      const reviewers = Array.isArray(item.requested_reviewers) ? item.requested_reviewers.filter(isDynamicRecord) : [];
      const action =
        event === "issue.closed" || event === "pr.merged"
          ? "closed"
          : event === "issue.labeled"
            ? "labeled"
            : event === "assigned"
              ? "assigned"
              : event === "pr.reviewRequested"
                ? "review_requested"
                : event === "pr.updated"
                  ? "synchronize"
                  : "opened";
      // Closed/merged snapshots must reflect the actual state, not synthesize a close for an open item.
      if (action === "closed" && item.state !== "closed") continue;
      result.push({
        event: pullRequest ? "pull_request" : "issues",
        body: {
          ...body,
          action,
          ...(pullRequest ? { pull_request: subject } : { issue: item }),
          ...(labels[0] ? { label: labels[0] } : {}),
          ...(assignees[0] ? { assignee: assignees[0] } : {}),
          ...(reviewers[0] ? { requested_reviewer: reviewers[0] } : {}),
        },
      });
    }
    return result;
  }).bind(this);

  readonly #copyFile = Effect.fn("WorkflowConnectorGitHub.copyFile")(function* (
    this: WorkflowConnectorGitHub,
    repository: string,
    folder: string,
    file: WorkflowGitHubFile,
  ) {
    const source = new URL(file.url);
    if (
      source.protocol !== "https:" ||
      source.username ||
      source.password ||
      source.port ||
      !PUBLIC_FILE_HOSTS.has(source.hostname) ||
      file.size > FILE_LIMIT
    )
      return { url: null, refused: false };
    const downloaded = yield* this.#http
      .bytes(source.href, FILE_LIMIT)
      .pipe(Effect.mapError((error) => this.#failure(error)));
    const content = downloaded.toString("utf8");
    const redacted = redactText(content);
    const textFile = file.contentType.startsWith("text/") || file.contentType === "application/json";
    // A declared binary file can still contain a known key, for example in image metadata. Changing
    // its bytes could damage it. Refuse the file, including its original link, instead.
    if (!textFile && content !== redacted) return { url: null, refused: true };
    const bytes = textFile ? Buffer.from(redacted) : downloaded;
    const branch = yield* Effect.result(this.#request(repository, `/git/ref/heads/${FILE_BRANCH}`));
    if (branch._tag === "Failure") {
      const details = record(yield* this.#request(repository, ""));
      if (typeof details?.default_branch !== "string") return { url: null, refused: false };
      const head = record(
        yield* this.#request(repository, `/git/ref/heads/${encodeURIComponent(details.default_branch)}`),
      );
      if (!isDynamicRecord(head?.object) || typeof head.object.sha !== "string") return { url: null, refused: false };
      // A concurrent copy may create the same branch. A contents write below can still use it.
      yield* Effect.result(
        this.#request(repository, "/git/refs", "POST", {
          ref: `refs/heads/${FILE_BRANCH}`,
          sha: head.object.sha,
        }),
      );
    }
    const folderId = createHash("sha256").update(folder).digest("hex").slice(0, 24);
    const fileId = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const name =
      redactText(file.name)
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .slice(0, 128) || "attachment";
    const path = `workflow-files/${folderId}/${fileId}-${name}`;
    const existing = yield* Effect.result(this.#request(repository, `/contents/${path}?ref=${FILE_BRANCH}`));
    const saved = existing._tag === "Success" ? record(existing.success) : null;
    if (!saved)
      yield* this.#request(repository, `/contents/${path}`, "PUT", {
        message: "Store a Tommy workflow attachment",
        content: bytes.toString("base64"),
        branch: FILE_BRANCH,
      });
    return { url: `https://github.com/${repository}/blob/${FILE_BRANCH}/${path}`, refused: false };
  }).bind(this);

  /** Copies public-source attachments first. An unavailable source keeps only a safe original link. */
  readonly attachFiles = Effect.fn("WorkflowConnectorGitHub.attachFiles")(function* (
    this: WorkflowConnectorGitHub,
    change: WorkflowGitHubChange,
  ) {
    const links: string[] = [];
    for (const file of (change.files?.files ?? []).slice(0, 20)) {
      try {
        const url = new URL(file.url);
        if (url.protocol !== "https:" || url.username || url.password) continue;
        const copied = yield* Effect.result(this.#copyFile(change.repository, change.files?.folder ?? "files", file));
        if (copied._tag === "Success" && copied.success.refused) continue;
        const link = copied._tag === "Success" ? copied.success.url : null;
        // A signed source URL is not posted into a repository when it cannot be copied.
        const safe = link ?? (!url.search && redactText(url.href) === url.href ? url.href : null);
        if (!safe) continue;
        const label = redactText(file.name).replace(/[[\]\\\r\n]/g, "_");
        links.push(`[${label}](<${safe.replaceAll(">", "%3E")}>)`);
      } catch {
        // A bad attachment does not prevent the text of the change from being sent.
      }
    }
    return { ...change, body: [change.body, ...links].filter(Boolean).join("\n\n"), files: null };
  }).bind(this);
}
