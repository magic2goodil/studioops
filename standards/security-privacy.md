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

## Consent And Opt-In

Consent-sensitive capabilities must be explicit product requirements, not afterthoughts.

Require clear opt-in and revocation paths for:

- precise or background location
- push notifications, SMS, email, or other outbound messaging
- social presence, friend visibility, check-ins, and "headed there" activity
- behavioral analytics tied to a user profile
- personalization or recommendation profiles
- AI training, coaching, persuasion, hypnosis, or other behavior-shaping experiences
- sharing data with third parties, integrations, advertisers, or business customers

Consent copy should explain what is collected, why it is collected, how it is used, who can see it, and how the user can turn it off. Do not bundle unrelated permissions together when separate consent is practical.

## Data Minimization

- Collect only what the feature needs.
- Prefer coarse, aggregated, or derived data when precise raw data is not required.
- Define retention and deletion behavior for sensitive data.
- Keep user-identifying analytics aggregated unless identity is necessary for the feature.
- Make sensitive inferred interests or behavioral scores reviewable or resettable when practical.

## Legal/Product Surface

Production-bound projects that collect PII or behavior data should have:

- Privacy Policy
- Terms and Conditions
- consent language for sensitive permissions
- account deletion or data deletion path
- support/contact path for privacy questions
- age and jurisdiction considerations when relevant

## Logging

- Do not log tokens, passwords, precise private location, payment data, or unnecessary PII.
- Prefer aggregate analytics when identity is not required.

## Actions With Side Effects

Do not send emails, SMS, push notifications, webhooks, production deploys, or external messages without explicit approval.

## Review Requirement

Reviewers should fail work that broadens data exposure, weakens auth, logs sensitive data, stores prototype session state where durable secure storage is required, adds sensitive data collection without a consent path, or makes it hard for a user to revoke consent.
