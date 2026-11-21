# Provider terms

Tommy does not sell, resell or pay for model usage. Each provider CLI signs in with your own
account or key, and your agreement with that provider applies to all usage. Tommy does not check
that your use agrees with a provider's terms, and a provider can limit or close an account that
breaks them.

This page is not legal advice. It tells how Tommy starts a provider and what the provider
publishes.

## Claude

### How Tommy runs Claude

- Tommy uses the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). The SDK
  starts the Claude Code CLI (`claude`), and the CLI sends all requests to Anthropic.
- Tommy downloads `claude` from Anthropic's npm package for your platform
  (`@anthropic-ai/claude-agent-sdk-<platform>`), checks the npm `dist.integrity` hash, and does not
  change the executable. It turns off the CLI's own updater for that copy only. With
  `TOMMY_CLAUDE_PATH`, Tommy runs that executable instead. With no downloaded copy, it runs a
  `claude` that you installed.
- The operator runs Anthropic's own CLI to sign in under the server's service account. The Linux installation guide gives the setup command and the restricted service environment file for the long-lived token. Tommy uses that account when its agents run Claude. See [provider setup](INSTALL.md).

### What Anthropic says

Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance),
read on 2026-10-06:

- "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and
  Enterprise subscription plans and is designed to support ordinary use of Claude Code and other
  native Anthropic applications."
- "Developers building products or services that interact with Claude's capabilities, including
  those using the Agent SDK, should use API key authentication through Claude Console or a
  supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai
  login into their own applications, or to route requests through Free, Pro, or Max plan
  credentials on behalf of their users."
- "developers may not collect, store, or intermediate Claude.ai credentials or session tokens —
  sign-in to a Claude account must complete through Anthropic's own flow."
- This does not "prevent an end user from signing in to the unmodified Claude Code binary with their
  own Claude subscription, including where a platform hosts Claude Code".
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code
  and the Agent SDK."
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without
  prior notice."

Anthropic has not confirmed to the Tommy project that subscription sign-in through Tommy is
permitted. For your own use case, Anthropic tells you to
[contact sales](https://www.anthropic.com/contact-sales).

### Risk by use

| Use | Risk with a Claude subscription |
| --- | --- |
| Your own work on your own computer | Not clear. You sign in to the unmodified CLI on Anthropic's page, which Anthropic permits. But Tommy is an Agent SDK product, and Connect starts the Claude.ai login from Tommy. Agents that run without you can go past "ordinary, individual usage". |
| Code sign-in on a host from another computer | Higher. Tommy carries the sign-in code from your browser to the host. |
| Team members use Claude agents on your host | High. Other people's requests use one person's plan. |

An Anthropic API key, Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry is the
method that Anthropic tells Agent SDK products to use. The CLI uses it before a subscription sign-in
([precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)), and
Tommy passes its environment to the CLI. Set `ANTHROPIC_API_KEY` in the environment that starts
Tommy, or in the `env` block of `~/.claude/settings.json`. For a cloud provider, see Anthropic's
[third-party integrations](https://code.claude.com/docs/en/third-party-integrations).

## Other providers

Tommy runs each provider's CLI with your own sign-in or key, and that provider's terms apply.
Before you use a subscription plan, read what the provider says about third-party tools.
