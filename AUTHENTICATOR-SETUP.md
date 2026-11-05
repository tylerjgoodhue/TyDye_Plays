# CreatorHQ authenticator authentication

## Enable it on your account

After publishing the app changes, sign in to CreatorHQ and open **Settings →
Two-factor authentication → Set up authenticator app**. Scan the QR code in a
TOTP authenticator, or expand the manual setup key. Enter the app's current
six-digit code and choose **Verify and enable**.

Two-factor authentication starts only after the first code is verified. Future
password sign-ins stop at the code screen until a valid authenticator code is
entered. An already verified session can remain signed in through normal token
refresh; refreshing the page does not force another code.

Add a backup authenticator or enable your authenticator app's secure backup
before relying on one device. Removing an authenticator requires a fresh code
from that authenticator. Removing the last one disables two-factor authentication.
Setup secrets are displayed only during setup, are not put into workspace saves,
and are cleared from the setup screen after verification or cancellation.

## Lost authenticator

Use a backup authenticator if available. If all authenticators are lost, the
Supabase project owner must verify the account owner's identity and remove/reset
the affected account's MFA factors using Supabase's administrative tools. Keep
project-owner access secure and separate from the CreatorHQ account. A password
reset does not remove an enrolled authenticator. CreatorHQ does not generate
recovery codes or provide a self-service bypass.

## Server setup

The database migration `20261105000000_authenticator_mfa.sql` and the updated
Buffer, Dropbox, Fourthwall, social-accounts, social-analytics, and staff-admin
functions were applied to the linked project on November 5, 2026.

The local Supabase configuration enables TOTP enrollment and verification.
Hosted Supabase projects enable TOTP by default; if setup reports that enrollment
or verification is disabled, check Authentication's MFA settings in that project.
Do not push the entire local auth configuration over an existing hosted project
just to enable TOTP, as that could replace unrelated production auth settings.

The frontend changes still need to be committed and pushed to GitHub Pages.
GitHub's release checks include MFA regression tests and the built MFA module.
Do not enable a real account's factor until the updated frontend is published.

Database policies require AAL2 for authenticated access when a user has a verified
factor, in addition to existing row ownership policies. Public profile/linktree
RPCs remain public. Private Edge Functions validate the user with Supabase Auth,
then inspect server-returned factors and the authenticated token's AAL before
using service credentials. OAuth callbacks retain their existing signed-state
flow; starting a new connection still requires the authenticated MFA check.

## Verification

- Automated tests cover pending enrollment, bad codes, successful verification,
  cancellation, abandoned setup cleanup, fresh-code removal, the workspace gate,
  and backend rejection of password-only sessions with enabled factors.
- Database policies were tested with synthetic accounts in a rolled-back
  transaction: unenrolled access works, enrolled AAL1 access fails, AAL2 ownership
  access works, and AAL2 does not bypass another user's ownership.
- Setup and sign-in screens were tested with synthetic data, including the phone
  layout. No real user was enrolled or had an authenticator removed by this work.
- Finish a real enrollment and sign-out/sign-in check yourself after publishing;
  this requires your authenticator app and was not simulated against your account.

Reference: [Supabase authenticator-app MFA](https://supabase.com/docs/guides/auth/auth-mfa/totp).
