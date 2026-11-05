# One workplace, individual accounts

CreatorHQ now uses the creator owner's existing workplace record and connections
for the whole team. Each person signs in with their own account. Signing in as an
editor no longer starts an empty, separate workplace or requires a separate
Dropbox or Buffer connection.

## Add editors

In **Staff**, create an account using **Editor — shared content and files**.
This adds explicit, owner-managed membership in the workplace. The Editor preset
includes the homepage, tasks, stream schedule, content pipeline, and file access.
It does not include changing connections, managing the website, or publishing.
The owner can grant social posting or other permissions to an editor who needs
them. Staff roles and permissions are checked against database membership,
not editable account profile metadata.

There were no existing staff accounts to migrate when this change was applied.
For an account manually created in Supabase, use Staff's Edit user action and
save its role/permissions to add it to this workplace. Creating a Supabase Auth
account alone does not grant workplace access.

## Shared and personal settings

- Shared: creator/workplace identity, schedule, content, permitted records,
  publishing drafts, and authorized use of the owner's existing connections.
- Personal: sign-in email, authenticator factors, and the account's display name,
  accent, and dashboard preferences. The display preferences are saved per account
  in Supabase; authenticator factors are managed by Supabase Auth.
- Connection management stays with accounts that have workspace settings access.
  An editor can browse/link authorized Dropbox files through the shared connection
  without being able to replace or disconnect that connection.

## Content and homepage

**Buffer & content** now contains **Content pipeline**, **Compose**, and
**Publishing planner**. Pipeline/composer/planner pages link to one another.
Existing content IDs and records are retained.

**Today’s next steps** stays on the homepage. Its shared counts and links still
cover scheduled content, ready content, items needing attention, and overdue
work. Editors without publishing permission open content for editing; publishers
can prepare/manage Buffer posts and refresh linked post statuses.

## Working together

CreatorHQ loads the shared workplace before opening it for a signed-in account.
Changes save to that workplace. Other open, visible sessions check for team
updates every 15 seconds when they have no unsaved changes or open editing forms. This is not a
simultaneous text editor.

Every save includes the loaded workplace revision. If someone else saved a newer
version, the stale save is rejected and automatic sync pauses. Unsaved edits stay
in active page memory. **Load team changes** keeps a private Supabase recovery checkpoint and loads
the latest shared version; use Recovery/save history to recover or copy your
unmerged work. This avoids silently overwriting another person's changes.

Editors can save only fields their role permits; sending changed settings in an
API request does not grant permission to change the shared settings. Cloud reads
are filtered too. Two-factor checks still apply to every account that enables
an authenticator.

## Deployment and checks

The `20261105010000_shared_workplace.sql` migration and private integration
functions were applied to the linked project on November 5, 2026. Existing owner
workspace data and connection records retain their IDs. The frontend still needs
to be committed and pushed to GitHub Pages.

Verification includes a rolled-back database transaction with synthetic owner,
editor, and unrelated accounts; shared-content updates; protected fields;
concurrent-save rejection; MFA; and membership self-enrollment denial. Automated
tests cover editor account provisioning, shared integration use, the homepage
next-step renderer, and loading shared content before unlocking the app. UI
walkthroughs use synthetic content, not real editor accounts or live posts.
