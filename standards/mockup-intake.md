# Mockup Intake And Design Critique Standards

## Purpose

Mockups are not implementation instructions by themselves. They are visual evidence that must be interpreted against the product vision, business goals, existing codebase, and technical standards.

Before implementation, run a mockup intake pass that classifies every meaningful visible element and turns it into buildable work.

## Element Inventory

For each visible element, identify:

- element name
- screen or page
- exact region in the mockup
- purpose
- audience
- whether it is static, editable content, dynamic data, or interactive UI
- source of truth
- route or action target
- component(s) involved
- responsive behavior for mobile, tablet, desktop, and wide desktop where relevant
- loading, empty, error, disabled, hover, focus, and active states where relevant
- accessibility expectations
- privacy/security implications
- ticket or epic that owns it

Examples:

- Hero eyebrow: editable content field.
- Primary CTA: reusable button component, editable label/URL, routes to business signup.
- Trusted business row: dynamic/curated content with business permission/approval rules.
- Product nav dropdown: information architecture task until route/page items are validated.
- Map pin: reusable map-pin component with image/logo, category, selected, cluster, and pulse variants.

## Classification

Every element should be classified as one of:

- Confirmed requirement: explicitly supported by the product plan or user request.
- Inferred requirement: not explicitly stated, but clearly supports the product and should be documented.
- New feature candidate: plausible and potentially useful, but needs a task/decision before implementation.
- Visual placeholder: likely added by the mockup/AI to make the screen feel complete.
- Needs decision: ambiguous, risky, or inconsistent with the product plan.
- Remove/defer: should not be implemented now.

Do not throw away plausible new ideas just because they were AI-invented. Capture them as candidates with rationale and a recommended next step.

## Page And Route Map

For every page implied by a mockup, define:

- route
- page title
- audience
- auth requirements
- SEO requirements
- primary user goal
- sections
- components
- content model
- data sources
- states
- breakpoints
- dependencies
- acceptance criteria

Navigation and subnavigation must not remain decorative. If a nav item appears in the mockup, it needs a route decision: build now, build later, remove, or needs product decision.

## Component Map

For every repeated UI pattern, define or reuse a component:

- button
- card
- navigation item
- sidebar item
- feature block
- hero
- media/image block
- map pin
- pulse/wave
- chart
- KPI card
- avatar stack
- badge/chip
- action card
- tabs
- modal
- form field

If two builders would naturally build the same thing independently, the component must be created in the foundation/design-system work first.

## Breakpoints

Mockup intake must consider:

- mobile
- tablet
- desktop
- wide desktop where relevant

If only one breakpoint is supplied, infer the other breakpoints and document the assumptions. Do not implement only the visible breakpoint unless the task explicitly scopes that.

## Critique Output

The critique should produce:

- page/epic list
- element inventory
- component inventory
- route map
- content model map
- dynamic data/source map
- privacy/security notes
- new feature candidates
- visual placeholder/defer list
- build-order recommendation
- acceptance criteria for generated tasks

## Review Requirement

Reviewers should send work back when:

- mockup elements were implemented blindly without classification
- nav items have no route/page decision
- editable content is hard-coded
- dynamic regions are filled with unlabeled fake data
- components are duplicated instead of reused
- breakpoints are missing
- plausible new feature candidates were either ignored or implemented without a task/decision
- privacy/security implications were skipped for location, social, auth, analytics, or notification surfaces
