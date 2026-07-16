# Mission Control Local Configuration

Copy this file to `mission-control.config.md` and customize it for your machine.

This file is intentionally Markdown so a human, Codex, Claude, Antigravity, or another coding agent can read it before doing work.

Do not paste private keys, API tokens, passwords, customer data, or secrets into this file.

## Setup Questions

When an AI agent or setup wizard configures this project, ask:

1. What name should Mission Control use for you?
2. What GitHub user or organization owns your repos?
3. Do you use GitHub CLI, SSH, HTTPS, or a mix?
4. Where do you keep local project checkouts?
5. Which AI coding tools do you want prompts for? Examples: Codex, Claude, Antigravity.
6. Which projects should be registered first?
7. What safety rules apply per project?
8. What validation command should run before a task moves to review?

## Security Rules

- Verify GitHub access with `gh auth status` or `ssh -T git@github.com`.
- Never ask users to paste a private SSH key into Mission Control.
- Prefer the user's existing SSH agent, GitHub CLI login, or OS keychain.
- Keep this file local. It is ignored by Git.
- Keep secrets in each project's normal secret manager or environment files, not here.

## Machine-Readable Config

The app reads the first fenced `json mission-control-config` block in this file.

```json mission-control-config
{
  "owner": {
    "displayName": "Your Name",
    "githubOwner": "your-github-user-or-org"
  },
  "git": {
    "preferredProtocol": "ssh",
    "defaultBranch": "main",
    "branchPrefix": "codex/"
  },
  "aiTools": [
    "codex"
  ],
  "workspace": {
    "root": "~/Development"
  },
  "defaults": {
    "validationCommands": [
      "npm run check"
    ],
    "standards": [
      "standards/engineering.md",
      "standards/frontend.md",
      "standards/styles.md",
      "standards/javascript.md",
      "standards/assets.md",
      "standards/seo.md",
      "standards/performance.md",
      "standards/accessibility.md",
      "standards/security-privacy.md",
      "standards/testing.md",
      "standards/review-checklist.md"
    ],
    "safetyRules": [
      "Do not deploy production without explicit approval.",
      "Do not send emails, push notifications, or external messages without explicit approval.",
      "Do not commit secrets, private keys, tokens, or private customer data."
    ]
  },
  "projects": [
    {
      "key": "example",
      "name": "Example Project",
      "description": "Replace this with your project.",
      "repoPath": "~/Development/example",
      "repoUrl": "git@github.com:your-github-user-or-org/example.git",
      "defaultBranch": "main",
      "contextLinks": [
        "README.md",
        "AGENTS.md"
      ],
      "standards": [
        "standards/engineering.md",
        "standards/frontend.md",
        "standards/styles.md",
        "standards/javascript.md",
        "standards/assets.md",
        "standards/seo.md",
        "standards/performance.md",
        "standards/accessibility.md",
        "standards/security-privacy.md",
        "standards/testing.md",
        "standards/review-checklist.md"
      ],
      "validationCommands": [
        "npm run check"
      ],
      "safetyRules": [
        "Do not deploy production without explicit approval."
      ]
    }
  ]
}
```
