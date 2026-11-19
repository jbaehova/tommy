// The request bodies of the Local scripts API (`automation-server.ts`) that need more than a type check.
import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import type { RespondToApprovalInput } from "@tommy/contracts/ipc";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";
import { sourceText } from "@tommy/i18n/source";

/** The status that the automation server answers with, carried on the throw. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function promptAnswers(value: unknown): Record<string, string[]> {
  if (!isDynamicRecord(value)) {
    throw new HttpError(400, "answers is required.");
  }
  const entries = Object.entries(value);
  if (entries.length > INPUT_LIMITS.promptQuestions) {
    throw new HttpError(400, "Too many prompt answers.");
  }
  const answers: Record<string, string[]> = {};
  let totalTextLength = 0;
  for (const [key, answer] of entries) {
    if (
      key.length > INPUT_LIMITS.identifier ||
      !Array.isArray(answer) ||
      answer.length > INPUT_LIMITS.promptAnswersPerQuestion ||
      !answer.every((item) => isString(item) && item.length <= INPUT_LIMITS.promptAnswerText)
    ) {
      throw new HttpError(400, "A prompt answer is invalid.");
    }
    totalTextLength += answer.reduce((length, item) => length + item.length, 0);
    if (totalTextLength > INPUT_LIMITS.promptAnswersTotalText) {
      throw new HttpError(400, sourceText("error.agent.promptAnswersTooLong"));
    }
    answers[key] = answer;
  }
  return answers;
}

export function approvalDecision(value: unknown): RespondToApprovalInput["decision"] {
  if (value === "accept" || value === "decline") return value;
  throw new HttpError(400, "approval decision is invalid.");
}
