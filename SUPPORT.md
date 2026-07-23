# StudioOps Support

StudioOps is an open-source developer-preview project maintained through GitHub.

## Before Requesting Help

Review:

- [Getting Started](docs/GETTING_STARTED.md)
- [Local Automation](docs/LOCAL_AUTOMATION.md)
- [Security Policy](SECURITY.md)
- the troubleshooting section in [README.md](README.md)

Run:

```bash
npm run check
npm run status-agents
npm run supervisor
npm run dispatcher -- --plan
npm run runner -- --plan
```

## Bug Reports And Feature Requests

Use [GitHub Issues](https://github.com/magic2goodil/studioops/issues). Include:

- expected and observed behavior;
- reproduction steps;
- operating system, Node.js version, and StudioOps version or commit;
- relevant project mode, provider, and worker status;
- redacted logs or screenshots when useful.

Never include credentials, private keys, access tokens, private repository content, customer information, production data, or unredacted prompts and logs.

## Security Reports

Follow [SECURITY.md](SECURITY.md). Use GitHub private vulnerability reporting when available. Do not disclose exploit details or sensitive data in a public issue.

## Support Boundary

Community support is best effort. There is no guaranteed response time or service-level agreement. StudioOps contributors cannot recover local databases, repositories, credentials, or external GitHub changes that were not backed up.
