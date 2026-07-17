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
  "githubApps": {
    "mode": "single",
    "credentialsDir": ".mission-control/github-apps",
    "defaultRole": "default",
    "roleMap": {
      "builder": "default",
      "backend-reviewer": "default",
      "frontend-reviewer": "default",
      "accessibility-reviewer": "default",
      "lead-reviewer": "default"
    }
  },
  "defaults": {
    "supervisor": {
      "intervalSeconds": 300,
      "baseUrl": "http://127.0.0.1:4317",
      "ownerNotificationStatus": "user_review",
      "builderConcurrency": 1,
      "reviewerConcurrency": 2,
      "requireHumanMerge": true,
      "requireGitHubActionsDeploy": true
    },
    "dispatcher": {
      "intervalSeconds": 300,
      "provider": "prompt-outbox",
      "maxDispatchesPerSweep": 6,
      "builderConcurrency": 3,
      "reviewerConcurrency": 3,
      "ownerConcurrency": 10,
      "requireHumanMerge": true,
      "requireGitHubActionsDeploy": true
    },
    "runner": {
      "intervalSeconds": 300,
      "limit": 3,
      "provider": "codex-cli",
      "useWorkspaces": true,
      "workspaceRoot": "~/.mission-control/run-workspaces",
      "timeoutMs": 7200000,
      "githubAppAuth": true,
      "githubAppCredentialsDir": ".mission-control/github-apps"
    },
    "qaIntegration": {
      "intervalSeconds": 300,
      "validationTimeoutMs": 600000
    },
    "selfUpdate": {
      "intervalSeconds": 300,
      "remote": "origin",
      "branch": "main",
      "staleRunMs": 7200000,
      "notify": false
    },
    "validationCommands": [
      "npm run check"
    ],
    "reviewPolicy": {
      "maxBuilderReviewCycles": 2,
      "reviewerMayFixSmallIssues": true,
      "leadOwnsFinalDecisionAtLimit": true,
      "trustLeadApprovals": false,
      "qaReviewerRole": "qa-reviewer",
      "integrationBranch": ""
    },
    "trustLeadApprovals": false,
    "integrationBranch": "",
    "reviewPipeline": [
      {
        "key": "backend",
        "label": "Backend Review",
        "role": "backend-reviewer",
        "status": "backend_review",
        "required": true,
        "description": "Review API contracts, persistence, indexes, auth, privacy, security, migrations, and deployment risk."
      },
      {
        "key": "frontend",
        "label": "Frontend Review",
        "role": "frontend-reviewer",
        "status": "frontend_review",
        "required": true,
        "description": "Review UI/UX, responsiveness, accessibility, design-system reuse, content editability, and browser health."
      },
      {
        "key": "accessibility",
        "label": "Accessibility Review",
        "role": "accessibility-reviewer",
        "status": "accessibility_review",
        "required": true,
        "description": "Expert review of contrast, readable typography, focus-visible states, keyboard behavior, semantics, labels, alt text, ARIA use, and screen-reader basics before lead review."
      },
      {
        "key": "lead",
        "label": "Primary Lead Review",
        "role": "lead-reviewer",
        "status": "lead_review",
        "required": true,
        "description": "Review product fit, architecture, cross-cutting risk, prior reviewer findings, PR/task scope, and readiness for the human owner."
      }
    ],
    "standards": [
      "standards/engineering.md",
      "standards/design-system.md",
      "standards/frontend.md",
      "standards/styles.md",
      "standards/javascript.md",
      "standards/assets.md",
      "standards/seo.md",
      "standards/performance.md",
      "standards/accessibility.md",
      "standards/security-privacy.md",
      "standards/testing.md",
      "standards/release-deployment.md",
      "standards/content.md",
      "standards/review-checklist.md"
    ],
    "safetyRules": [
      "Do not deploy production without explicit approval.",
      "PR merges and protected integration branch pushes must not deploy production by default; production deploys must run from explicit releases or tags after safety checks.",
      "Release/tag deploy workflows must verify the target commit is reachable from the protected integration branch and gated to the approved deploy owner or allowed deployer list.",
      "Manual workflow_dispatch deploys must be dry-run or preview-only unless explicitly approved for an emergency production path.",
      "Production deployment automation must not use broad delete/sync cleanup or remove production env files, databases, uploads, media, generated assets, logs, virtualenvs, backups, or production-only state.",
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
      "trustLeadApprovals": false,
      "integrationBranch": "qa/integration",
      "contextLinks": [
        "README.md",
        "AGENTS.md"
      ],
      "standards": [
        "standards/engineering.md",
        "standards/design-system.md",
        "standards/frontend.md",
        "standards/styles.md",
        "standards/javascript.md",
        "standards/assets.md",
        "standards/seo.md",
        "standards/performance.md",
        "standards/accessibility.md",
        "standards/security-privacy.md",
        "standards/testing.md",
        "standards/release-deployment.md",
        "standards/review-checklist.md"
      ],
      "validationCommands": [
        "npm run check"
      ],
      "reviewPolicy": {
        "maxBuilderReviewCycles": 2,
        "reviewerMayFixSmallIssues": true,
        "leadOwnsFinalDecisionAtLimit": true,
        "trustLeadApprovals": false,
        "qaReviewerRole": "qa-reviewer",
        "integrationBranch": "qa/example"
      },
      "reviewPipeline": [
        {
          "key": "backend",
          "label": "Backend Review",
          "role": "backend-reviewer",
          "status": "backend_review",
          "required": true,
          "description": "Required when backend, data, auth, privacy, API, analytics, queues, or deployment behavior changes."
        },
        {
          "key": "frontend",
          "label": "Frontend Review",
          "role": "frontend-reviewer",
          "status": "frontend_review",
          "required": true,
          "description": "Required when UI, UX, frontend assets, content rendering, responsiveness, or accessibility changes."
        },
        {
          "key": "accessibility",
          "label": "Accessibility Review",
          "role": "accessibility-reviewer",
          "status": "accessibility_review",
          "required": true,
          "description": "Required before lead review when UI, UX, frontend assets, content rendering, responsiveness, or accessibility changes; otherwise skip explicitly."
        },
        {
          "key": "lead",
          "label": "Primary Lead Review",
          "role": "lead-reviewer",
          "status": "lead_review",
          "required": true,
          "description": "Always required before a task moves to qa_review or user_review."
        }
      ],
      "safetyRules": [
        "Do not deploy production without explicit approval.",
        "PR merges and protected integration branch pushes must not deploy production by default; production deploys must run from explicit releases or tags after safety checks.",
        "Release/tag deploy workflows must verify the target commit is reachable from the protected integration branch and gated to the approved deploy owner or allowed deployer list.",
        "Manual workflow_dispatch deploys must be dry-run or preview-only unless explicitly approved for an emergency production path.",
        "Production deployment automation must not use broad delete/sync cleanup or remove production env files, databases, uploads, media, generated assets, logs, virtualenvs, backups, or production-only state."
      ]
    }
  ]
}
```
