# Asset Standards

## Icons

- Use one icon system per project.
- Prefer an SVG sprite sheet or an approved icon package.
- Do not paste unrelated inline SVGs throughout templates.
- Do not mix icon styles.
- Icons must have accessible labels when they represent actions.

## Images

- Use responsive image sizes.
- Provide `width` and `height` attributes or CSS `aspect-ratio` to avoid layout shift.
- Lazy-load below-the-fold images.
- Do not lazy-load the primary Largest Contentful Paint image.
- Use modern formats such as WebP or AVIF when the project pipeline supports them.
- Do not ship oversized display images.

## Asset Organization

Recommended structure:

```text
src/assets/
  icons/
  images/
  source/
public/assets/
  generated/
```

## Generated Assets

- Optimized assets belong in generated/public output directories.
- Source assets should remain editable.
- Do not commit huge raw assets unless they are true source material.

