# Styling Standards

## Sass Source

- Write maintainable source styles in Sass when the project supports Sass.
- Do not hand-edit compiled CSS.
- Compiled CSS must be generated through the project build command.
- Development builds should include source maps when practical.

## File Organization

Recommended Sass structure:

```text
src/styles/
  _tokens.scss
  _mixins.scss
  _base.scss
  _layout.scss
  _components.scss
  _forms.scss
  _utilities.scss
  app.scss
```

Project-specific structure may vary, but styles should still be organized by responsibility.

## Naming

- Use predictable component class names.
- Prefer BEM-like structure for reusable components:
  - `.event-card`
  - `.event-card__image`
  - `.event-card__title`
  - `.event-card--featured`
- Avoid vague classes such as `.box`, `.thing`, `.left`, or `.blue` unless they are local utilities.

## Forbidden Patterns

- No random inline styles for layout.
- No broad selectors like `div div span`.
- No `!important` unless documented.
- No magic spacing values scattered throughout a file.
- No CSS that depends on accidental DOM structure.
- No styling that fixes one breakpoint by breaking another.

## Tokens

- Use design tokens for color, spacing, radius, type size, shadow, and z-index.
- Do not invent one-off values unless the design requires it.

## Review Requirement

Reviewers should fail style work that is visually acceptable but structurally unmaintainable.

