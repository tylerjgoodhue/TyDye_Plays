# Public website release checks

## Automatic publishing checks

GitHub Pages now runs all 49 tests before building. It then validates the seven
built HTML pages, inline and external JavaScript syntax, local script/style assets,
and public JSON configuration before uploading anything for deployment.

Run locally with Node.js 22.13 or newer:

```sh
node --test scripts/contact-form.test.cjs scripts/public-site.test.cjs scripts/workflow.test.mjs supabase/functions/buffer/buffer.test.mjs supabase/functions/dropbox/handler.test.mjs supabase/functions/dropbox/oauth.test.mjs
node scripts/build-site.mjs
node scripts/check-release.mjs
```

These checks do not need production login credentials and do not publish posts,
upload files, send email, or place orders. They do not replace a live walkthrough.

## Walkthrough — November 4, 2026

- Homepage: no broken images or missing section targets at desktop width.
- Phone: no horizontal page overflow at 390px and 320px; sticky navigation and
  quick actions remain available.
- Shop: collection loads; search produces a useful empty state; sorting works.
- Product: options control availability and enable adding to the cart.
- Cart: adding, changing quantity, removing, and the empty state work.
- Checkout: reaches the Fourthwall contact/shipping/payment screen. No order placed,
  and no contact, address, or payment information entered. Test item removed.
- Schedule: downloaded calendar uses the correct UTC start/end for the published
  Chicago stream time, with real calendar line endings.
- Contact: empty messages and invalid emails are blocked. Valid draft formatting
  is covered automatically; sending from a visitor's email app was not tested.
- Accessibility fix: shop content uses the existing main landmark rather than
  nesting a second main landmark.

## Content to finish before launch

- Replace the published About placeholder text and remove the trailing `l` from
  the About heading in CreatorHQ.
- Fix the Website social link from `https://wwwtydyeplays.com/` to
  `https://tydyeplays.com/` in CreatorHQ.
- Correct `Ty-Dye Plays T-Shirtd` in the Fourthwall product catalog; check whether
  both similar shirt listings are intended.

Social destination URLs were inspected, but third-party channel pages and a
completed purchase were not validated. Repeat a quick check on the deployed
custom domain after pushing; local checks cannot verify GitHub's actual deployment.
