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
- Personalized coaching or other behavior-shaping experiences
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

## Application Security Verification

Select and record risk-appropriate OWASP ASVS 5.0 controls for the changed surface. A checklist or scanner does not establish full ASVS verification. At minimum, applicable changes must address:

- Deny access by default and enforce resource ownership, role, and tenant authorization on every entry path, including APIs, background jobs, and alternate routes. Add negative tests for unauthenticated, wrong-role, wrong-owner, and cross-tenant access where applicable.
- Use parameterized database queries, context-appropriate output encoding, and vetted sanitization when rendering intentionally permitted HTML. Validate input type, shape, range, and size on the trusted boundary; client validation alone is insufficient.
- Protect session cookies with appropriate Secure, HttpOnly, and SameSite settings; rotate sessions at authentication/privilege changes and invalidate them on logout or revocation. Protect cookie-authenticated state-changing requests against CSRF; do not rely on SameSite alone where it is insufficient.
- Grant least privilege to service identities and credentials. Review dependency advisories for reachability and impact; fix or record an accountable, time-bounded mitigation with owner and review date rather than ignoring alerts or treating every alert as proof of exploitability.

References: [ASVS](https://asvs.owasp.org/), [authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), [XSS prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html), and [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
