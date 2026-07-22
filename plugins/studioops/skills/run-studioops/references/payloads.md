# StudioOps intake payloads

Use one JSON object with `project` and `task` keys.

```json
{
  "project": {
    "key": "storefront",
    "name": "Storefront",
    "description": "Customer-facing commerce application",
    "repoPath": "/absolute/path/to/storefront",
    "repoUrl": "https://github.com/example/storefront",
    "defaultBranch": "main",
    "validationCommands": ["npm run check"]
  },
  "task": {
    "title": "Add account recovery",
    "description": "Let customers recover access without exposing account existence.",
    "status": "ready",
    "priority": "high",
    "type": "feature",
    "area": "authentication",
    "lane": "backend",
    "workAreas": ["src/auth", "test/auth"],
    "userStory": "As a locked-out customer, I want to recover my account securely.",
    "expectedOutcome": "A customer can request and complete a time-limited recovery flow.",
    "acceptanceCriteria": [
      "Responses do not disclose whether an account exists",
      "Recovery tokens expire and cannot be reused",
      "Automated tests cover successful and rejected flows"
    ],
    "privacyNotes": "Minimize recovery telemetry and retention.",
    "securityNotes": "Rate-limit requests and hash stored tokens.",
    "attachments": []
  }
}
```

The client matches projects by `key`, `name`, `repoPath`, or `repoUrl`. When it finds a project, it reuses it and does not overwrite project configuration. A new project requires `project.key` and `project.name`. A task requires `task.title`; the client supplies `task.project` from the matched or created project.

Save the object to a JSON file and pass it with `intake --file <payload-file>`. Do not interpolate task text into a shell command: acceptance criteria and descriptions may legitimately contain backticks, dollar signs, quotes, or other shell syntax.
