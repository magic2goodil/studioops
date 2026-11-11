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
- Modal dialogs must contain keyboard focus while open and restore focus appropriately when closed.

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

## Conformance Target And Verification

Target WCAG 2.2 Level AA for web interfaces, including applicable Level A criteria. This checklist supplements rather than replaces the complete applicable success criteria.

- Text contrast must be at least 4.5:1, or 3:1 for large text as defined by WCAG. Applicable UI component and graphical-object contrast must be at least 3:1. Apply only the exceptions allowed by the relevant success criterion, such as inactive controls, and document their applicability.
- Support text resizing to 200% without loss of content or functionality. Verify reflow at 320 CSS pixels wide without two-dimensional scrolling, except content whose usage or meaning requires a two-dimensional layout.
- Keyboard focus must be visible and not entirely obscured by author-created content. Modal dialogs must contain keyboard focus while open and restore it to the invoking control or a logical next location when closed; users must have an operable way to dismiss them.
- Pointer targets must be at least 24 by 24 CSS pixels or meet a WCAG 2.2 target-size exception, such as sufficient spacing or an equivalent control. Document exceptions rather than silently skipping the check.
- Provide a single-pointer alternative to dragging where required. Authentication must not require a cognitive function test without an allowed alternative or assistance mechanism; support password managers and paste.
- Combine automated checks with manual keyboard, zoom/reflow, focus, contrast, and relevant screen-reader checks on representative flows. Record tested surfaces, tools, findings, and gaps. A clean scanner report alone is not a conformance claim.

References: [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [WAI evaluation guidance](https://www.w3.org/WAI/test-evaluate/).
