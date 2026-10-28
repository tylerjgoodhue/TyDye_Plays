# Creator HQ

A local-first creator workspace built as a single-page HTML application, with optional Supabase Auth and cloud snapshot sync. No build step or package install is required.

## Run locally

Open `index.html` in a modern browser, or serve this folder with any static file server. Without a configured cloud project, the app stores its workspace in browser `localStorage` under `creator-hq-v1`.

Cloud sync loads Supabase JS from `esm.sh`, so the browser needs network access to that CDN when the cloud module starts. The rest of the local workspace remains available if that module cannot load.

## Deploy with GitHub Pages

The included `.github/workflows/pages.yml` builds and deploys the static site to GitHub Pages when you push to `main` or `master`, or run the workflow manually. It publishes only `dist/`; `.env.*` files, the setup script, and Supabase backend source are not included.

1. Push this project to a GitHub repository. Keep `.env.*` files and provider credentials out of Git; the ignore rules already exclude them. GitHub Pages on a free plan generally requires a public repository, while private-repository Pages availability depends on your plan.
2. In the repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
3. Push to `main` or `master`, or run **Actions → Deploy static site to GitHub Pages → Run workflow**. Wait for the deployment job to complete.
4. With the default project URL, the public website is `https://OWNER.github.io/REPOSITORY/`, Creator HQ is `https://OWNER.github.io/REPOSITORY/CreatorHQ/`, and Linktree is `https://OWNER.github.io/REPOSITORY/linktree.html`. Replace `OWNER` and `REPOSITORY` with the actual GitHub values.
5. To use a custom domain, add repository Actions variables `PAGES_BASE_PATH=/` and `PAGES_CUSTOM_DOMAIN=your-domain.example`, then follow GitHub's DNS instructions under **Settings → Pages**. The build writes the required `CNAME` file. Without these variables, the build correctly defaults to `/<repository>/` for project Pages and does not publish a CNAME file.
6. In Supabase Authentication → URL Configuration, set the Site URL to the deployed Creator HQ URL ending in `/CreatorHQ/`. Add that URL, and any local/test URLs, to Redirect URLs. For the default GitHub project site this includes `https://OWNER.github.io/REPOSITORY/CreatorHQ/`; for a custom domain use `https://your-domain.example/CreatorHQ/`.
7. Set the Supabase Edge Function `ALLOWED_APP_ORIGINS` secret to include the exact deployed origin: `https://OWNER.github.io` for the default project site, or `https://your-domain.example` for a custom domain. Origins have no path or trailing slash. Preserve other origins you still use. This secret is used by Buffer, Fourthwall, social click analytics, platform accounts, and Twitch live status.
8. Keep the provider OAuth callback registered as `https://asqszzgunsrdclunbxfq.supabase.co/functions/v1/social-accounts`. Check each provider's website/domain allowlist as applicable, and ensure the Supabase redirect allowlist includes the Creator HQ URL.

The bare site root reads the public website profile from Supabase using the connection settings in `public-profile.json`. That file contains no website content, and the public site does not fall back to a stale local copy if the database profile is unavailable. Apply `20261028000000_public_creator_profiles.sql` and `20261029000000_public_creator_linktree.sql` before deploying this version. In Creator HQ, connect Supabase and sign in as the configured site owner; edits to public website and Linktree fields then sync automatically. When a database profile already exists, Creator HQ loads it as the source of truth instead of overwriting it with this browser's local profile. Only sanitized public projections are written, never tasks or private workspace records. The public profile table has owner-only writes; separate public read RPCs return only the website or Linktree projection. The publish-file download remains a fallback and preserves the Supabase publication settings. The file is public; do not put private workspace information in it. Copy Linktree URL is the short `/linktree.html` path; the editor preview alone uses a private data fragment. GitHub Pages must be updated once to include the short-link client and read function; until then its currently hosted app will continue using the old long-fragment Linktree links.

To test the production layout locally, run `node scripts/build-site.mjs` and serve `dist/`. To test the default GitHub project path locally, set `GITHUB_REPOSITORY=OWNER/REPOSITORY` before running the build. For a custom domain build, set `PAGES_BASE_PATH=/`.

## Current features

- Creator profile, responsive dashboard, customizable accent and widgets
- Separate editable Twitch creator website and Linktree pages, each with independent settings, preview, and public URL (`profile.html` and `linktree.html`)
- Task board with search, filters, recurring work, and drag-and-drop
- Weekly stream rhythm, individual sessions, completion history, and ICS export
- Content pipeline, searchable ideas, goals, weekly review, and routines
- Asset links and small image previews (650 KB per image)
- Connected-platform analytics, community events/feedback, local reminders, and collaboration tracking
- Linktree click analytics for links managed on the Linktree page (requires the `social-analytics` Edge Function and migration)
- JSON backup export and import
- Buffer publishing desk for connected channels, queue viewing, and scheduled posts (requires a deployed Supabase Edge Function and Buffer API key)

All records are local to the current browser profile. Clearing browser data removes them. Export a JSON backup before changing devices or browser profiles. Imported files are user-controlled input; only import backups you trust.

The **Edit Website** and **Linktree** sections in Creator HQ are separate editors with independent saved identity, appearance, links, and public URLs. Website share links point to the public root and load the live database profile; only Creator HQ's private website preview uses a URL fragment containing public website fields. Linktree's public page uses `linktree.html`, while its editor preview uses a private data fragment. These fragments never include tasks, analytics, or other workspace records. Both configurations are saved with the local workspace and included in JSON backups and optional cloud workspace snapshots.

The Creator HQ **Shop** view integrates with Fourthwall. After configuring the server-side Fourthwall API credentials below, use **Sync Fourthwall** to load the live catalog, select a product template, upload artwork, create and publish Fourthwall apparel products, update storefront availability, hide/publish, or archive products. The public creator website syncs the product catalog and sends shoppers to Fourthwall's hosted checkout using the selected variant. Product information included in the public website share link is public storefront data. Fourthwall currently does not expose inventory quantity writes through its API; manage stock quantities in the Fourthwall dashboard.

## Configure Supabase cloud sync

1. Create a Supabase project.
2. Apply `supabase/migrations/20261025000000_creator_workspaces.sql` in the Supabase SQL editor, or run it using the Supabase CLI after linking your project.
3. In Supabase Auth, enable Email and choose whether email confirmation is required. Set the Supabase **Site URL** to `http://127.0.0.1:8765/` for local testing and add that same URL under **Redirect URLs**. Creator HQ sends confirmation and recovery emails back to the current app page, so each deployed HTTPS origin must also be allowed. If an earlier confirmation email used the wrong redirect, update the allowlist, then use **Resend confirmation email** in Cloud Sync. To use GitHub, create a GitHub OAuth App, enable GitHub under Supabase Auth → Sign In / Providers, and enter the OAuth client ID and secret in Supabase. Set the GitHub OAuth App callback URL to `https://asqszzgunsrdclunbxfq.supabase.co/auth/v1/callback` for the currently configured project.
4. Open Creator HQ → Cloud sync. Enter the Project URL and anon/publishable key from the Supabase project settings, then connect.
5. Sign in with email/password or **Continue with GitHub**. If you first registered through GitHub and want a password, enter the same account email, select **Forgot password?**, and use the emailed link on the same app origin to set a password. Configure that origin in Supabase's allowed redirect URLs. Choose **Upload local & enable sync** to initialize that account's cloud snapshot, or **Restore cloud workspace** to replace this browser's workspace with an existing snapshot.

After opting in, subsequent local saves are uploaded to that account. **Pause cloud sync** stops future uploads. Sign-out also pauses sync. The configuration and Supabase client session are saved in this browser; the password is not saved by Creator HQ.

The database policy restricts each workspace row to its authenticated owner. Apply and review the migration before enabling accounts. The browser app uses only the public anon/publishable key; never use the service-role key here.

Cloud restore replaces local workspace data, so export a backup first if you are unsure. Cloud snapshots exclude asset image bytes; those remain on the original browser and are not transferred. The snapshot is capped at 1.5 MB. This first migration intentionally uses a versioned JSONB snapshot as a safe bridge from the existing local app; it is not yet a normalized relational schema for individual tasks and content records.

## Configure Buffer publishing

Creator HQ calls Buffer's official GraphQL API (`https://api.buffer.com`) through a Supabase Edge Function. The Buffer key is never entered in the browser.

1. In Buffer, create a personal API key at [Settings → API](https://publish.buffer.com/settings/api).
2. In Supabase **Authentication → Users**, copy the UUID for your Creator HQ user.
3. Link the local Supabase CLI to your configured project once: `supabase link --project-ref asqszzgunsrdclunbxfq`.
4. Create an ignored local `.env.local` file in the project root containing these values (do not commit it):

	```sh
	BUFFER_API_KEY=your_buffer_api_key
	BUFFER_ALLOWED_USER_ID=your_supabase_auth_user_uuid
	ALLOWED_APP_ORIGINS=http://127.0.0.1:8765
	```

5. From the project folder, deploy the secrets and function:

	```sh
	supabase secrets set --env-file .env.local
	supabase functions deploy buffer
	```

6. Reload Creator HQ while signed in, then open **Social Media Management → Compose** to create posts or **Scheduled** to review the queue in list or month-calendar view. Use **Load next 50** to page older scheduled entries into the calendar.

The composer can post to up to ten selected channels in one batch, with shared copy and optional per-channel copy and image/video URL overrides. Each channel is a separate Buffer post; partial success is reported per channel and failed channel drafts remain in the form. Posts can go to the next Buffer queue slot or to an exact time. The calendar/list includes scheduled posts and can page through the queue. Buffer supports YouTube and several social networks, but not Twitch livestream publishing. Use **Stream schedule** for Twitch streams; use Buffer for stream announcements, clips and VOD promotions. Buffer's API requires media to be hosted at a public, stable HTTPS URL; private/local asset uploads are not attached yet. Some networks may require native reminder publishing, which Buffer reports per channel/post.

## Configure Twitch live status

The public creator website checks the Twitch channel URL and refreshes its live/offline badge once a minute. The Twitch app secret stays in Supabase; the static page calls the `twitch-status` Edge Function and never calls Twitch with private credentials.

1. Register an application in the [Twitch Developer Console](https://dev.twitch.tv/console/apps) and copy its Client ID and Client Secret.
2. Add these entries to the ignored `.env.local` file described above, using the channel login from the URL (for example, `mychannel` from `https://twitch.tv/mychannel`). Set allowed origins to the exact origins hosting the app; include both local origins if testing locally.

	```sh
	TWITCH_CLIENT_ID=your_twitch_client_id
	TWITCH_CLIENT_SECRET=your_twitch_client_secret
	TWITCH_CHANNEL_LOGIN=your_channel_login
	ALLOWED_APP_ORIGINS=http://127.0.0.1:8765,https://your-site.example
	```

3. From the project folder, upload the secrets and deploy the function:

	```sh
	supabase secrets set --env-file .env.local
	supabase functions deploy twitch-status
	```

4. Serve the local site from an allowed origin or deploy `index.html`, `profile.html`, and `linktree.html` together. The public website reports “Live status unavailable” until the function has valid secrets and the page's origin is allowlisted. The endpoint is restricted to the single `TWITCH_CHANNEL_LOGIN` value.

## Configure social link analytics

Linktree click tracking stores aggregate click events for the links configured on the **Linktree** page. IP information is used transiently in memory for rate limiting and is not written to the database; visitor names and browsing history are not collected. The signed-in owner can see click totals in **Social Media Management → Analytics**.

1. Apply `supabase/migrations/20261026000000_social_link_analytics.sql` to the connected Supabase project.
2. The function uses Supabase's injected `SUPABASE_SECRET_KEYS.default` for privileged database writes and `SUPABASE_PUBLISHABLE_KEYS.default` for session validation (with legacy runtime key fallbacks). Do not add these reserved `SUPABASE_` variables manually or place a secret key in browser settings or frontend code.
3. Ensure `ALLOWED_APP_ORIGINS` contains the exact origins serving Creator HQ and the public Linktree page, then deploy with `supabase functions deploy social-analytics`.
4. Reconnect/reload Creator HQ, add links on the Linktree page, and share the refreshed Linktree URL. Only clicks on the Linktree page are counted; profile URLs and direct social traffic are not.

Follower, reach, view, and engagement metrics require each platform's official API and explicit account authorization. A profile URL is not an authorization credential. OAuth and metrics import code is implemented below; provider credentials, redirect registration, and user consent are still required before account data appears. Twitch live status remains a separate public stream-status integration.

## Configure platform account metrics

The **Social Media Management → Analytics → Platform performance** report connects Twitch, YouTube, Instagram, and TikTok through one server-side OAuth function. Manage account authorization in **Workspace settings**. Provider access and refresh tokens are encrypted with AES-GCM before they are written to the service-role-only tables. OAuth states are one-time, hashed, and expire after 10 minutes. No provider token is returned to the browser.

1. Apply `supabase/migrations/20261027000000_platform_account_metrics.sql`.
2. In each provider's developer app, register this exact OAuth callback URL: `https://asqszzgunsrdclunbxfq.supabase.co/functions/v1/social-accounts`. The callback returns to the Creator HQ URL that initiated authorization (for GitHub Pages, the project path plus `/CreatorHQ/`) on an origin configured in `ALLOWED_APP_ORIGINS` and Supabase Redirect URLs.
3. Enable the required provider products and scopes in each developer console:

	- Twitch: `moderator:read:followers`; use the same Twitch app whose client credentials are configured in Supabase.
	- YouTube: enable YouTube Data API v3 and YouTube Analytics API; request `youtube.readonly` and `yt-analytics.readonly`. Add your Google account as a test user while OAuth consent is in testing mode, or complete Google's publishing/verification requirements.
	- Instagram: use Business Login for Instagram and request `instagram_business_basic` plus `instagram_business_manage_insights`. The connected account must be Creator or Business. Meta Standard Access is sufficient for app-owned/test accounts; Advanced Access and review are needed for external users.
	- TikTok: enable Login Kit and the scopes `user.info.basic`, `user.info.stats`, and `video.list`. TikTok app review/approval may be required before these scopes are granted.

4. To configure one provider at a time, run `bash ./setup-social-account-secrets.sh twitch` or `bash ./setup-social-account-secrets.sh youtube`; to configure all four providers later, run `bash ./setup-social-account-secrets.sh all`. The helper prompts in your terminal, hides secret input, generates the AES key and scheduler secret locally, writes to the ignored, owner-only `.env.social-accounts` file, uploads the values to the linked Supabase project, and deploys the Edge Function. Existing local values are preserved, including the encryption key, so adding providers later will not invalidate stored tokens. Do not send credential values in chat. The script updates the selected provider's credentials with the values entered, so use the app registered with the callback above.

	```sh
	openssl rand -base64 32
	openssl rand -base64 32
	```

	Use the first output for `SOCIAL_TOKEN_ENCRYPTION_KEY` and the second for `SOCIAL_SYNC_CRON_SECRET`. Store these, plus `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET`, `TIKTOK_CLIENT_KEY`, and `TIKTOK_CLIENT_SECRET`, in Supabase Function secrets. If using a local env file, use a new ignored file dedicated to these settings, then run `supabase secrets set --env-file .env.social-accounts`.

4. Deploy with `supabase functions deploy social-accounts`. Connect each account from Workspace settings. Platform metrics refresh automatically while Analytics or Settings is open.
6. To refresh daily without opening the app, schedule a daily POST to `https://asqszzgunsrdclunbxfq.supabase.co/functions/v1/social-accounts` with JSON body `{"action":"scheduledSync"}` and header `x-social-sync-secret: <SOCIAL_SYNC_CRON_SECRET>`. Use Supabase Scheduled Functions/cron plus Vault-backed secret injection; do not save the cron secret in a committed SQL migration or a public URL.

Provider notes: Twitch imports follower count and current live viewers; YouTube imports public channel totals and the last 28 days of views, watch time, and subscriber changes; Instagram imports professional-account follower/media totals and supported daily insights; TikTok imports profile totals and aggregate counts for the latest public videos returned by the authorized API. Provider permissions, data availability, and app review are controlled by each platform. Instagram Insights requires an eligible professional account and `instagram_business_manage_insights`; TikTok requires approval for the requested `user.info.stats` and `video.list` scopes. A provider can be connected while some metrics remain unavailable; errors are shown on that provider's row.

Do not rotate `SOCIAL_TOKEN_ENCRYPTION_KEY` without first migrating/re-encrypting all stored provider tokens. Disconnecting an account deletes its token and imported metrics. The provider authorization can also be revoked from the provider's own account settings.

## Configure Fourthwall shop integration

The Creator HQ Shop view calls Fourthwall from a Supabase Edge Function, so Fourthwall API credentials are never stored in browser code or workspace data. This integration is for one Fourthwall shop and uses a dedicated Open API user.

1. In Fourthwall, open **Settings → For Developers → Open API** and create an API user. Fourthwall requires the **Super Admin** role to create API credentials. Keep the generated username and password private.
2. Add the API username/password to the ignored `.env.local` file. In Supabase Authentication → Users, copy your Creator HQ user's UUID into `FOURTHWALL_ALLOWED_USER_ID`. Never put the Fourthwall API password in the frontend or public share data.

	```sh
	FOURTHWALL_API_USERNAME=your_fourthwall_api_username
	FOURTHWALL_API_PASSWORD=your_fourthwall_api_password
	FOURTHWALL_ALLOWED_USER_ID=your_supabase_auth_user_uuid
	```

3. Create an ignored `.env.fourthwall` file in the project root containing only the three Fourthwall settings above. The repository ignores `.env.*` files. Use this file so uploading Fourthwall secrets does not overwrite other integration secrets:

	```sh
	supabase secrets set --env-file .env.fourthwall
	supabase functions deploy fourthwall
	```

4. Connect the Supabase project and sign in to Creator HQ. Open **Shop** and use **Products** to sync the catalog or create apparel, **Orders** to review Fourthwall orders and shipping addresses, **Inventory** to read stock by product variant, and **Shipping** to record a carrier and tracking number for items you fulfill yourself. After updating the Edge Function, deploy it with `supabase functions deploy fourthwall` before using Orders, Inventory, or Shipping.

Creating apparel requires Fourthwall templates and registered artwork. Inventory quantities, production, shipping rates, taxes, payment methods, refunds, discounts, and payouts remain managed in the Fourthwall dashboard; this API integration only reads inventory and can record fulfillment tracking for merchant-shipped items. The public site builds a variant-specific `/cart/checkout?products=...` link on your Fourthwall shop domain. Do not paste Fourthwall API credentials into the browser, public product fields, or chat.

The API key is account-wide, not organization-scoped. The Edge Function therefore checks both Supabase authentication and the configured `FOURTHWALL_ALLOWED_USER_ID` (or the existing Buffer allowlist fallback). Keep the allowlisted user ID private to your own setup, and deploy only to the Supabase project configured for this app.

## Security and integrations

Supabase provides account authentication and row-isolated workspace sync only after you configure a project and apply the migration. Buffer publishing, Twitch live-status lookup, Linktree click analytics, and platform account metrics use server-side Edge Functions described above. The browser's local cache is not encrypted, and cloud sync does not add application-level encryption. Do not store passwords, access tokens, confidential contracts, or sensitive financial details here. Browser notifications are opt-in and depend on browser permission and context.

Never place Discord bot tokens, OAuth client secrets, or other provider credentials in this frontend. A production integration needs server-side OAuth/token handling, secret management, provider callback configuration, and least-privilege permissions.

## Production architecture and remaining work

Before treating this as a production service, add server-managed integrations and private asset storage. Keep authenticated records scoped to an owner with database row-level security. Put uploaded assets in private object storage with explicit file limits. Proxy third-party APIs through server routes; do not send provider secrets to the browser.

The current workspace migration stores `creator_workspaces` (one JSONB snapshot per authenticated user). The social-link analytics migration adds normalized owner-scoped links and aggregate click events. For larger teams or reporting, migrate remaining entities such as `tasks`, `streams`, `content_items`, `ideas`, `goals`, `assets`, `analytics_entries`, `community_events`, `community_feedback`, and `collaborations` into tables with owner IDs and appropriate access policies. Keep integration credentials in a server-side secret store, not these tables in plaintext.

## Pre-deployment checklist

- Configure Supabase Auth email confirmation, password recovery, and allowed redirect URLs.
- Add normalized database tables, migrations, per-user authorization policies, and server-side input validation.
- Move asset uploads to private object storage; validate size and actual file content server-side.
- Configure HTTPS, security headers, a restrictive content security policy, and dependency/update monitoring.
- Implement and test OAuth only for providers that are configured; document required scopes and revoke flows.
- Add automated tests for task/content transitions, backup migration, date handling, and authorization boundaries.
- Test keyboard navigation, screen-reader names, reduced motion, mobile layouts, and browser storage failure states.
- Confirm backups can be restored and define retention/deletion behavior before launch.

## Data behavior

The analytics view intentionally shows no demonstration numbers. Audience metrics appear only after an explicitly authorized platform integration; Linktree click counts are collected automatically after social analytics is configured. Reminders are derived from saved workspace dates and are limited to overdue items plus the next 14 days. No email or automatic Discord announcement service is active.

## Live Fourthwall storefront

The public shop now uses Fourthwall's Storefront API directly. `storefront-config.json` contains the **public storefront token**, the checkout origin, and the collection slug. This token is intended for browser use. Never put the Platform API username/password or a Supabase secret key in this file.

- `shop.html`: live collection, search, price/name sorting, availability, and compact product cards.
- `product.html?product=<slug>`: full-resolution gallery, color-specific photos, size/color choices, live price and stock, quantity, sizing guidance, product details, and the actual Fourthwall returns policy. Older published product-ID links are resolved through the public profile.
- `cart.html`: a real Fourthwall cart, persisted by cart ID in this browser, with quantity changes, removal, server prices, and checkout validation. No local prices are trusted for checkout. The preview uses separate cart storage.
- `storefront.js` / `storefront.css`: shared shopping behavior and responsive layout. `profile.html` is the canonical page template; the build copies it to all public shopping routes.

Catalog data comes from the configured public Fourthwall collection (`all` by default) on each visit. Product/stock/photo changes do not require re-publishing the creator profile. Checkout uses the API-created cart at `/checkout/?cartCurrency=USD&cartId=...` on the configured Fourthwall shop domain. Shipping addresses, payment, tax, promo codes, and order confirmation are handled there. Fourthwall's public Storefront API does not expose a standalone payment form or a customer order-history API. The existing authenticated Creator HQ order/inventory/fulfillment tools remain available to the shop owner. Bundles are not included in this version of the product grid; the current store's regular products are supported.

The storefront reports loading failures with a retry control and disables unavailable variants. A cart is cleared only when Fourthwall confirms its ID no longer exists; network failures do not erase it. Cart mutations are never automatically replayed after a timeout, to avoid adding an item twice.

Build with `node scripts/build-site.mjs` and publish the generated `dist/` folder through the existing GitHub Pages workflow. The build includes all shop/cart/product pages, shared assets, and public configuration. Test locally by serving `dist/` over HTTP; opening HTML files directly cannot load configuration or call the APIs correctly.

Official references: [Storefront getting started](https://docs.fourthwall.com/storefront/getting-started), [Cart and checkout](https://docs.fourthwall.com/storefront/cart-checkout-tutorial), [Checkout setup](https://docs.fourthwall.com/storefront/checkout).
