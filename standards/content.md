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

## Authenticated CMS And Layout Builder

The default goal for owned products is that routine content and page composition changes do not require a code push.

When a page has editable marketing or product content, prefer an authenticated admin CMS model for:

- hero eyebrow, headline, supporting copy, and CTA labels/URLs
- hero/background images and share images
- feature panels, cards, and repeated content blocks
- section ordering
- panel visibility and scheduling
- trusted logos, testimonials, partner rows, and curated lists
- SEO title, description, canonical URL, and Open Graph/Twitter metadata

For pages with multiple sections, design the content model as a controlled layout builder rather than arbitrary HTML:

- define allowed block types
- define allowed fields per block
- validate required fields before publish
- store display order explicitly
- support draft, preview, published, archived, and scheduled states where practical
- record who changed content and when
- keep reusable visual components in code while letting admins choose content, order, and configured variants

Code should add new capabilities, block types, components, validations, and integrations. CMS edits should handle ordinary copy, images, ordering, and visibility changes.

Never use an unauthenticated CMS endpoint. Admin content editing must be role-gated, audited, and protected with normal session/security controls.

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
