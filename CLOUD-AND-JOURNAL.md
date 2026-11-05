# Cloud storage and website journal

CreatorHQ keeps its shared workplace, private uploaded assets, user preferences, recovery checkpoints, blog drafts, article history and publication schedule in Supabase. User settings belong to each account; content and integrations belong to the shared workplace. Dropbox, Buffer and Fourthwall continue to store their own service data.

## Browser behavior

The application no longer writes workspace data, preferences, drafts, cart references or authentication sessions to persistent browser storage. Active edits and sign-in live in page memory. Refreshing requires signing in again. Normal browser caching of downloaded website files is separate from application storage.

On the first authenticated visit, known old CreatorHQ browser records are archived privately in Supabase before being cleared. Authentication tokens are cleared without being archived. If archiving fails, old data is retained for recovery. Owner migration archives and private recovery checkpoints are available from the save-status/recovery button. Restore intentionally replaces the shared workplace; export first if needed.

Workspace changes save automatically. Watch the Supabase save status before closing. Offline or failed saves remain in the active page; closing without saving can lose those changes. Buffer's explicit draft-save action waits for Supabase. Guest shopping uses in-memory cart references across same-tab shop pages; a refresh clears that reference. Checkout remains on Fourthwall.

## Journal workflow

Open **Website & journal → Journal / blog**. Create a draft, write with Markdown formatting buttons and switch to Preview. Drafts autosave; published articles require an explicit update.

The editor includes summaries, categories, tags, featured articles, cover and inline images, alternative text, image credits, author names, URL slugs, search titles/descriptions, canonical URLs, noindex, duplicate, Markdown export, bulk JSON export, revision history, archive and recoverable trash. Restoring an older revision makes a draft copy so the live article is not silently overwritten.

Content editors can draft and submit for review. Owners and accounts with website/settings permission can publish or schedule. Conflicting edits are rejected rather than replacing another editor's work.

Select a future date/time and **Schedule**. The field uses the device's displayed timezone; Supabase stores UTC. Public queries and media check the database/server clock, so the article becomes available at its due time with the panel closed. Already-open public pages update on reload. Rescheduling a live article to the future hides it until that time.

Images remain in a private bucket. Public image delivery checks that the article is published and due, and that the requested image belongs to it. Unpublishing or trashing blocks new public image requests; previously downloaded copies cannot be revoked.

The public site includes the homepage's latest stories, searchable/filterable paginated journal, article pages, reading time, table of contents, related articles, sharing and RSS. The existing static hosting applies per-article metadata in JavaScript; social crawlers that do not run JavaScript may show generic metadata. Dedicated server-rendered article URLs would be a later hosting enhancement. Comments, email subscriptions and newsletter delivery are not included.

## Deployment

`20261105020000_cloud_blog.sql`, `blog-media` and `blog-feed` were applied/deployed November 5, 2026. The public functions intentionally allow anonymous requests but perform publication checks before returning data. Private tables/storage retain membership and MFA policies.

Push the frontend through the existing GitHub Pages workflow. The build creates `blog.html`, `blog-post.html` and CreatorHQ's editor assets. Run the checks in RELEASE-CHECKLIST.md with Node 22.13 or newer. No sample articles were seeded into production.
