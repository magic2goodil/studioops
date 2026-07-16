# Security And Privacy Standards

## Secrets

- Never commit secrets, tokens, private keys, credentials, customer data, or production dumps.
- Keep secrets in the project secret manager or environment files.
- Sample files must use fake values.

## PII

Treat the following as sensitive:

- auth data
- payment data
- location data
- social graph data
- behavioral analytics
- customer contact data
- business performance data

## Logging

- Do not log tokens, passwords, precise private location, payment data, or unnecessary PII.
- Prefer aggregate analytics when identity is not required.

## Actions With Side Effects

Do not send emails, SMS, push notifications, webhooks, production deploys, or external messages without explicit approval.

## Review Requirement

Reviewers should fail work that broadens data exposure, weakens auth, logs sensitive data, or stores prototype session state where durable secure storage is required.

