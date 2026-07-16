# Engineering Standards

## Source Of Truth

- Edit source files, not generated output.
- Generated files must be created by the project build command.
- Do not hand-edit minified CSS, minified JavaScript, compiled bundles, or generated manifests.
- Keep changes scoped to the task and avoid unrelated refactors.

## Formatting

- Use the formatter and indentation configured by the project.
- If the project does not specify indentation, use two spaces for web/frontend code and four spaces for Python.
- Do not mix tabs and spaces in the same file.
- Do not introduce broad whitespace churn.

## Code Shape

- Prefer clear, boring code over clever code.
- Add abstractions only when they reduce real duplication or clarify ownership.
- Keep naming explicit enough that a human maintainer can find and modify behavior later.
- Avoid hidden global state.
- Avoid copy-paste implementations of the same behavior in multiple places.

## Comments

- Comments should explain why a decision exists.
- Do not add comments that merely restate the code.
- Add a short note before non-obvious compatibility, performance, or security decisions.

## Task Closeout

Every builder closeout must record:

- changed files
- validation commands and results
- known gaps
- branch and PR link when available
- standards that were relevant to the change

