# Accessibility Standards

## Semantics

- Use semantic HTML before custom ARIA.
- Interactive controls must be buttons, links, inputs, or properly implemented ARIA controls.
- Headings must follow a logical hierarchy.
- Pages and dialogs should expose meaningful landmarks, titles, and section names.
- ARIA should clarify behavior only when native semantics cannot; avoid ARIA that conflicts with native roles or states.

## Keyboard

- All interactive controls must be keyboard reachable.
- Focus state must be visible.
- Tab order must follow the visible and logical reading order.
- Modals must support Escape to close when appropriate.
- Modals should keep focus within the modal while open when practical.

## Images And Icons

- Informative images need useful alt text.
- Decorative images should use empty alt text.
- Icon-only buttons need accessible labels.
- Links and buttons need names that describe the action or destination without relying on surrounding visuals.
- Avoid using `title` text as the only accessible name or the only way to expose important information.

## Forms

- Inputs, selects, textareas, and custom form controls need persistent labels.
- Errors and help text should be programmatically associated with the relevant field where practical.
- Required and invalid states must not be communicated by color alone.

## Color And Contrast

- Text contrast must be readable in normal and hover/focus states.
- Do not communicate state by color alone.
- Typography must remain readable across mobile, tablet, desktop, zoom, and responsive wrapping.

## Motion

- Avoid unnecessary motion.
- Respect reduced-motion preferences for non-essential animation.

## Screen Readers

- Dynamic state changes should be exposed through semantic state, focus movement, or live regions where appropriate.
- Custom menus, tabs, dialogs, and disclosure controls need screen-reader understandable names, roles, states, and keyboard behavior.
