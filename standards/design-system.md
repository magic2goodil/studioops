# Design System And Component Standards

## Design Source

- UI work should start from a design artifact when one exists: Figma, Sketch, image mockup, screenshot, Storybook, or an equivalent design reference.
- The design artifact should identify component states and responsive behavior, not only a single static screen.
- If the design artifact only covers mobile, the builder must infer tablet and desktop behavior unless the task explicitly scopes mobile only.

## Component Specs

Reusable UI should be specified as components before page implementation.

For each component, define:

- purpose
- anatomy
- mobile layout
- tablet layout
- desktop layout
- variants
- interactive states
- empty/error/loading states when applicable
- accessibility requirements
- data requirements

Example component spec:

```text
Event Card
- Mobile: stacked image, title, metadata, CTA.
- Tablet: image left or top depending container width.
- Desktop: horizontal card or grid card based on section layout.
- Variants: default, featured, compact, sold out.
- States: loading, image missing, hover/focus, disabled CTA.
```

## Reuse Rule

- Repeated UI must be built as a reusable component.
- Do not duplicate markup and styling for the same button, card, badge, modal, navigation item, or form control.
- If one component must differ, create a documented variant instead of a one-off copy.
- Changes to a shared component should happen in one source location and flow everywhere that component is used.

## Parallel Builder Sequencing

When multiple builders will implement screens from the same product or mockup:

1. Create a foundation task first.
2. Inventory reusable components, typography, spacing, colors, surfaces, map treatments, cards, buttons, charts, icons, and motion.
3. Define the shared Sass/API/component locations before page work starts.
4. Make page tasks depend on the foundation task.
5. Run a frontend lead review before page work reaches human review.

The frontend lead review should reject duplicate mixins, duplicate button systems, duplicate card systems, incompatible responsive rules, and page-specific styling that should have been a shared variant.

## Template Architecture

- Prefer component templates for shared markup.
- Twig is acceptable and preferred for PHP/Drupal-style projects when already available.
- Other template systems are acceptable when they are native to the stack, such as React/Vue/Svelte components, Astro components, Blade, Nunjucks, or server-rendered partials.
- Do not bury reusable component HTML inside one page template if it will be used elsewhere.

Recommended Twig-style structure:

```text
templates/
  components/
    button.twig
    event-card.twig
    modal.twig
  pages/
    events.twig
```

## Sass API

- Shared visual decisions should be expressed through tokens, mixins, functions, or component classes.
- Buttons, cards, badges, forms, layout containers, and media treatments should not be rebuilt from scratch per page.
- Use Sass mixins for reusable patterns that need configurable output.
- Use classes for reusable component identities.

Example:

```scss
@mixin button-primary {
  border-radius: var(--radius-pill);
  background: var(--gradient-primary);
  color: var(--color-button-text);
}

.button--primary {
  @include button-primary;
}
```

## Component Catalog

- Projects with significant UI should maintain a component catalog.
- Storybook is preferred when the stack supports it and the project has enough UI surface to justify it.
- A simpler static component gallery is acceptable for smaller projects.
- The catalog should show responsive states and variants, not only the happy path.

Minimum catalog coverage for reusable components:

- default state
- hover/focus state where relevant
- disabled state where relevant
- loading state where relevant
- mobile, tablet, and desktop examples

## Design Tokens

Use tokens for:

- color
- typography
- spacing
- radius
- shadow
- z-index
- motion

Avoid hard-coded one-off values when the value represents a system decision.

## Review Requirement

Reviewers should fail UI work when:

- repeated UI is duplicated instead of componentized
- a shared component is changed in only one usage
- mobile is implemented but tablet/desktop are ignored
- Sass mixins/tokens/classes are bypassed with page-specific hacks
- the implementation does not map clearly to the supplied design artifact
- Storybook or the component catalog exists but was not updated for a changed shared component
- multiple builders created conflicting visual systems instead of using the foundation/component API
