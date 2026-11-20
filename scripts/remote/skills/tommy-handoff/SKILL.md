---
name: tommy-handoff
description: Compact the context of this session and send it to an agent on the Tommy host. Use when the user invokes /tommy-handoff, or asks to hand off, pass on, or send this session or its context to Tommy or a Tommy agent.
---

# Hand off this session to a Tommy agent

Write a summary of this session, as a context compaction does, and send it with the `tommy-remote send` command. The receiver sees only this summary. A fact that is not in it is lost.

## Steps

1. Run `tommy-remote agents --json`. The command reaches the Tommy server over SSH. If it fails, show the error and stop. Each agent shows `chat: true` when it has a Telegram chat; the handoff and the agent's answer then appear in that chat.
2. Get two choices from the user, unless the request already states them:
   - The agent. Show its name and provider. If you have a tool to ask questions and four or fewer agents exist, use it. Otherwise list the agents and ask.
   - The mode: `work` (the agent continues the work) or `record` (the agent keeps the summary and does not act).
3. Write the summary, as the next section says. Do this after the choices, so that it includes the newest messages.
4. Send it. Use a quoted heredoc, so that the shell changes nothing in the text:

   ```bash
   tommy-remote send --agent <id> --mode <work|record> --source "<project or topic>" <<'TOMMY_HANDOFF_END'
   <summary>
   TOMMY_HANDOFF_END
   ```

5. Tell the user the agent name, the mode, where it went (`chat=telegram` or `chat=tommy`), and the size and redaction count that the command printed. A successful command means that the host accepted the message. It does not mean that the agent read it or finished a reply. If the command fails, show the error and do not say that the handoff was sent.

Do not repeat the summary in your reply unless the user asks. Do not change the work or the files of this session for the handoff.

## How to write the summary

First go through the whole session in order, from the first message to the last. Make these notes for yourself, and do not send them: each request of the user, what you did about it, each decision and its reason, each error and its fix, each correction from the user, and the exact details. Then write from the notes.

Write for a capable reader with no access to this session. Use the language of the user's messages, and keep names, values, and quotations unchanged. Use these sections in this order. Leave out a section that has no content. This applies to any session: code, research, writing, planning, or a plain question.

1. **Goal.** What the user wants, with every explicit request and each change to a request. Say what done looks like.
2. **User's instructions.** Each constraint, preference, and correction that still applies. Quote the user when the exact words matter. Say which earlier instruction a later one replaced.
3. **Decisions.** Each decision, its reason, who made it, and the options that were rejected and why. This stops the receiver from trying them again.
4. **Current state.** What is done, what is in progress, and what is not started. For each result, say if it was verified and how, or that it was not verified. Do not present an assumption as a fact.
5. **Key information.** Everything that a reader cannot get again without this session: findings, sources and URLs, numbers, dates, names, IDs, and conclusions. Keep the details of a result, not only that it exists.
6. **Materials.** For a code session: the repository, remote, branch, last commit, and if the work is pushed; each important file and why it matters; exact commands; the code that is needed, in a code block; and uncommitted changes. For other work: each document and draft, and the text that is needed.
7. **Errors and corrections.** Each failure, its cause, the fix, and each approach that did not work.
8. **Next step.** The work in progress at the end of the session, and the next action. Quote the user's latest request. Give only a next step that the user asked for, and list open questions for the user apart from it.

## Rules

- The receiver runs on another computer. It cannot read this computer's files, this session, or local tools. Give a path as a location on this computer, and include the content that the receiver needs. Say so when work exists only on this computer, such as uncommitted changes.
- Keep precise values exact: paths, commands, error text, IDs, and numbers. Do not replace them with a description.
- Remove only what no longer matters: repeated tool output, failed searches with no finding, and greetings. Do not shorten essential content to save space. A short session gets a short summary. The limit is 100,000 characters.
- Do not include a secret, such as a token, password, private key, or cookie. Say where the secret is stored instead. The command also redacts what it recognizes, but this does not find every secret.
- Do not add instructions for the receiver beyond the user's requests. The command adds the header that states the mode.
- Do not add content that the session does not support.
