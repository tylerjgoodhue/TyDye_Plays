# Gloss Studio in CreatorHQ

Open **In the studio → Gloss Studio**, next to Asset Library. It is a native panel view with the same navigation, theme, sign-in and asset-library permission.

Type up to 180 characters over six manual lines. Choose pink, lilac or alternating letters, then adjust size, spacing, line spacing, alignment and export quality. Long wording wraps automatically. Grid, dark and light backgrounds affect the preview only; exported PNGs remain transparent.

**Download PNG** exports the current lettering. **Save to library** creates or updates a shared asset with both its PNG and editable lettering settings. Open it later using **Edit lettering** in Gloss Studio or Asset Library. **Make a copy** creates a separate design. Changes are retained in memory if cloud saving fails, so keep the page open and retry. Signing out clears the in-memory editor.

## Persistence and permissions

Design settings live in `glossDesign` on an existing workspace asset record. The current shared-workplace save/revision flow handles them, and the existing `creatorhq-assets` bucket stores the PNG privately with signed preview/download URLs. This does not introduce a new database table, migration, persistent browser store, authentication bypass, or integration secret. Existing staff with the Asset Library permission can use the studio.

## Source and deployment

- `gloss-entry.mjs` connects the editor to the authenticated shell.
- `gloss-studio.mjs` renders the editor and canvas.
- `gloss-utils.mjs` bounds inputs, wrapping, filenames and export dimensions.
- `gloss-studio.css` supplies scoped responsive panel styling.
- `gloss-fonts/` contains the two custom color fonts.

The normal `scripts/build-site.mjs` includes all of these under `dist/CreatorHQ/`. Push the project through its existing GitHub Pages deployment to release them. No extra Supabase deployment is needed for this feature.

The fonts use layered color glyphs rendered by the browser into PNG. They are adapted from the TyDye Candy custom lettering. They are not dependent on Canva's font importer. Browser support is checked before enabling export; a visible retry/error state handles font loading failure.

## Validation

The local panel preview was checked on desktop and at 390px width. Font colors rendered, phrase changes worked, a failed save retained the wording, retry produced one saved record, and a real browser PNG download retained transparency. Cloud persistence tests verify design settings survive the existing asset-upload path. A live authenticated Supabase save was not performed during this change.

## Matching text styles

The Text style selector keeps the original candy lettering and adds Outfit ExtraBold for clean headlines, Outfit SemiBold for subheadings, Nunito Sans Regular for body copy, and Nunito Sans SemiBold for small labels. These companion styles have normal lowercase, editable solid colors and smaller text sizes. Saved assets keep the selected style and color; older assets without a style continue to use the candy font. Regular text supports up to 420 characters, while candy lettering stays at 180.

The font pack link includes four static TTF weight instances, the pairing guide and the original SIL Open Font Licenses. Fonts are self-hosted with the panel rather than fetched from a third-party font service. Original font credits and source URLs are supplied in the guide.
