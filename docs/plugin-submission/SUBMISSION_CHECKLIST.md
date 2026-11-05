# StudioOps Plugin Submission Checklist

## Prepared In Repository

- [x] Skills-only plugin manifest and skill tree
- [x] One-step setup skill
- [x] Public privacy notice
- [x] Public terms of use
- [x] Public support page
- [x] Listing copy and starter prompts
- [x] Five positive and three negative workflow examples prepared for local evaluation
- [x] Desktop-only `requires_local_executor` metadata for skills that call local programs
- [x] Current release notes
- [x] Allowlisted package builder and repository validation

## Publisher Actions

- [x] Public policy URLs exist on the repository's default branch
- [ ] Verify the submitting publisher identity; the contributor label is not business verification
- [ ] Confirm plugin-submission access for the selected OpenAI organization and verified Developer identity
- [ ] Complete developer or business verification
- [ ] Select countries or regions where the listing, support, privacy notice, and terms are ready
- [ ] Review every policy attestation for accuracy
- [ ] Upload the generated skills-only ZIP
- [ ] Review the prepared listing and release notes in the plugin submission portal
- [ ] Submit for OpenAI review
- [ ] Publish only after OpenAI approval and a final owner review

Do not mark publisher identity, regional availability, or policy attestations complete on the owner's behalf.

Local packaging and installation do not submit this listing to an external marketplace. Record a final package digest and verify current policy URLs before any separately authorized submission.

The repository marketplace remains available for local installation. Official public Plugins Directory publication is unverified.

Follow the current [official submission guide](https://developers.openai.com/plugins/deploy/submission). Its five-positive/three-negative test counts apply to MCP review; skills-only plugins do not need MCP app review cases or a demo recording. The examples above remain useful local workflow checks. This plugin uses local commands and follows the [desktop-only skills metadata guidance](https://developers.openai.com/plugins/deploy/desktop-only); it contains no MCP server.
