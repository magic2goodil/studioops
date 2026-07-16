# Frontend Standards

## Rendering Strategy

- Public marketing and content pages must render meaningful HTML without requiring client-side JavaScript.
- Authenticated dashboards and internal tools may use single-page app behavior when it improves workflow.
- SPA routes must support direct URL loading and browser refresh.
- Do not hide important content behind client-only rendering when SEO, sharing, or accessibility matter.

## Responsive Design

- Design and implement mobile first.
- UI tasks must account for mobile, tablet, and desktop behavior by default.
- If the user supplies only a mobile mockup, infer and implement tablet and desktop layouts that preserve the design intent.
- If a breakpoint is intentionally out of scope, the task must state that explicitly.
- Do not leave the rest of a page in an old design when redesigning a visible flow unless the task explicitly scopes a single component.
- When a mockup describes a reusable component, build the component and then use it in the page instead of hard-coding the page instance.

## Breakpoints

Default review breakpoints:

- Mobile: 375px wide
- Large mobile: 430px wide
- Tablet: 768px wide
- Desktop: 1280px wide
- Wide desktop: 1440px wide

Project-specific breakpoints may override these.

## Layout

- Prevent layout shift with explicit dimensions, aspect ratios, or skeleton states.
- Avoid nested cards unless there is a clear semantic reason.
- Do not rely on accidental DOM order for layout.
- Use stable containers and spacing tokens rather than one-off margin hacks.

## Async UI

Every async interface must define:

- loading state
- loaded state
- empty state
- error state
- retry path when appropriate

Async or API-driven UI is not implemented if it only updates hidden markup. If an API powers a visible product claim, the reviewed page must expose that data in the active experience or explicitly document that the API is staged for later work.

## Navigation And Links

Every generated or CMS-managed link must resolve to a real route, a real element ID on the page, or an explicitly disabled/non-clickable state.

Fragment links should be verified after rendering. Do not ship dropdowns or generated nav with broken `#section` targets.

## Visual Verification

UI tasks must include visual verification notes for mobile, tablet, and desktop. Screenshots are preferred when practical.

## Component Reuse

- Shared UI should come from reusable components, partials, or templates.
- Do not duplicate the same card, button, badge, modal, or navigation markup in multiple pages.
- If a shared component changes, update the shared source and verify every visible usage that is affected.
