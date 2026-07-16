# Review Checklist

Fail or send back the task when a material issue exists:

- Source files were skipped and compiled CSS or JS was hand-edited.
- Sass/CSS is hacky, unstructured, or not maintainable by a human.
- A visual change only updates one breakpoint while leaving tablet or desktop broken.
- A redesign updates one component but leaves the rest of the visible page in the old design without explicit scope.
- Public content relies entirely on client-side JavaScript for meaningful HTML.
- SEO metadata, canonical URLs, or structured data are missing for SEO-sensitive pages.
- Images lack dimensions, aspect ratios, or appropriate lazy-loading behavior.
- Async content causes avoidable layout shift.
- Large datasets or page sections load eagerly without need.
- API failures are invisible to users.
- There are browser console errors.
- The implementation ignores referenced mockups or visual attachments.
- The PR lacks validation notes.
- Sensitive data is logged, exposed, or stored casually.
- The work violates project-specific standards.

For UI work, reviewers should specifically ask:

- Was mobile verified?
- Was tablet verified?
- Was desktop verified?
- Was the direct URL/refresh path verified?
- Was the full visible page considered, not just the smallest component?

