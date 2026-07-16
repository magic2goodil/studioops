# Content And Information Architecture Standards

## Mockup Interpretation

Design mockups may contain placeholder navigation, filler labels, or AI-invented sections. Do not assume every visible item is a confirmed product requirement.

When implementing a mockup:

- Identify editable content regions.
- Identify dynamic data regions.
- Identify static design/brand elements.
- Identify navigation items and dropdowns.
- Confirm whether each nav item maps to existing product requirements, a new feature, or a placeholder that needs a decision.

If a visible element does not map to the product plan, create an information-architecture task instead of silently building a dead or meaningless page.

## Editable Content

For marketing pages and public product pages, define content models before hard-coding copy.

Common editable fields:

- eyebrow or kicker text
- headline
- highlighted headline segment
- supporting copy
- primary CTA label and URL
- secondary CTA label and URL
- feature card title, icon, body, and URL
- social-proof intro text
- trusted business/logo list source
- SEO title, description, canonical URL, and share image

Editable content should have sensible fallbacks, but fallback text must not hide missing configuration in production-like environments.

## Dynamic Content

When a mockup region is dynamic, define the source of truth.

Examples:

- trusted business row from approved businesses or curated featured businesses
- event cards from approved events
- map pins from approved businesses/events/live sessions
- dashboard metrics from aggregate analytics
- reviews or friends from consent-aware user data

Dynamic content tasks must define empty, loading, error, and permission states.

## Navigation

Navigation tasks should document:

- route path
- page purpose
- audience
- required auth state
- dropdown/subnav items
- source product requirement
- whether the page is build-now, build-later, or remove-from-nav

Do not leave navigation links as decorative placeholders.

## Review Requirement

Reviewers should send work back when:

- visible copy is hard-coded where the product needs editable content
- dynamic sections are implemented with fake data without clear demo labeling
- nav links exist with no defined destination or product reason
- AI-generated mockup items are built blindly without product validation
- SEO-sensitive pages lack metadata fields and meaningful server-rendered content
