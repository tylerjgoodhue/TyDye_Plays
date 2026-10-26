#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

mode="${1:-all}"
if [[ "$mode" != "all" && "$mode" != "twitch" && "$mode" != "youtube" ]]; then
  printf '%s\n' 'Usage: bash ./setup-social-account-secrets.sh [twitch|youtube|all]' >&2
  exit 2
fi

if ! command -v supabase >/dev/null 2>&1; then
  printf '%s\n' 'Supabase CLI is required. Install it, then run this script again.' >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  printf '%s\n' 'OpenSSL is required to generate local encryption and scheduler secrets.' >&2
  exit 1
fi

env_file="$PWD/.env.social-accounts"

existing_value() {
  local name="$1"
  if [[ ! -f "$env_file" ]]; then
    return 0
  fi
  sed -n "s/^${name}=//p" "$env_file" | tail -n 1
}

prompt_value() {
  local prompt="$1"
  local variable_name="$2"
  local secret="$3"
  local value
  value="$(existing_value "$variable_name")"
  if [[ -n "$value" ]]; then
    printf -v "$variable_name" '%s' "$value"
    printf '%s already saved in .env.social-accounts; keeping it.\n' "$variable_name"
    return
  fi
  if [[ "$secret" == "yes" ]]; then
    read -r -s -p "$prompt: " value
    printf '\n' >&2
  else
    read -r -p "$prompt: " value
  fi
  if [[ -z "$value" ]]; then
    printf '%s\n' "$variable_name is required; no secrets were uploaded." >&2
    exit 1
  fi
  printf -v "$variable_name" '%s' "$value"
}

if [[ "$mode" == "all" || "$mode" == "twitch" ]]; then
  prompt_value 'Twitch client ID' TWITCH_CLIENT_ID no
  prompt_value 'Twitch client secret' TWITCH_CLIENT_SECRET yes
fi
if [[ "$mode" == "all" || "$mode" == "youtube" ]]; then
  prompt_value 'YouTube OAuth client ID' YOUTUBE_CLIENT_ID no
  prompt_value 'YouTube OAuth client secret' YOUTUBE_CLIENT_SECRET yes
fi
if [[ "$mode" == "all" ]]; then
  prompt_value 'Instagram app ID' INSTAGRAM_CLIENT_ID no
  prompt_value 'Instagram app secret' INSTAGRAM_CLIENT_SECRET yes
  prompt_value 'TikTok client key' TIKTOK_CLIENT_KEY no
  prompt_value 'TikTok client secret' TIKTOK_CLIENT_SECRET yes
fi

SOCIAL_TOKEN_ENCRYPTION_KEY="$(existing_value SOCIAL_TOKEN_ENCRYPTION_KEY)"
SOCIAL_SYNC_CRON_SECRET="$(existing_value SOCIAL_SYNC_CRON_SECRET)"
if [[ -z "$SOCIAL_TOKEN_ENCRYPTION_KEY" ]]; then SOCIAL_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')"; fi
if [[ -z "$SOCIAL_SYNC_CRON_SECRET" ]]; then SOCIAL_SYNC_CRON_SECRET="$(openssl rand -hex 32)"; fi

umask 077
temporary_file="$(mktemp "$PWD/.env.social-accounts.XXXXXX")"
chmod 600 "$temporary_file"
trap 'rm -f "$temporary_file"' EXIT

write_env_value() {
  local name="$1"
  local value="$2"
  printf '%s=%s\n' "$name" "$value" >> "$temporary_file"
}

if [[ "$mode" == "all" ]]; then
  write_env_value TWITCH_CLIENT_ID "$TWITCH_CLIENT_ID"
  write_env_value TWITCH_CLIENT_SECRET "$TWITCH_CLIENT_SECRET"
  write_env_value YOUTUBE_CLIENT_ID "$YOUTUBE_CLIENT_ID"
  write_env_value YOUTUBE_CLIENT_SECRET "$YOUTUBE_CLIENT_SECRET"
  write_env_value INSTAGRAM_CLIENT_ID "$INSTAGRAM_CLIENT_ID"
  write_env_value INSTAGRAM_CLIENT_SECRET "$INSTAGRAM_CLIENT_SECRET"
  write_env_value TIKTOK_CLIENT_KEY "$TIKTOK_CLIENT_KEY"
  write_env_value TIKTOK_CLIENT_SECRET "$TIKTOK_CLIENT_SECRET"
elif [[ -f "$env_file" ]]; then
  while IFS= read -r line; do
    if [[ "$mode" == "youtube" ]]; then
      case "$line" in
        TWITCH_CLIENT_ID=*|TWITCH_CLIENT_SECRET=*|INSTAGRAM_CLIENT_ID=*|INSTAGRAM_CLIENT_SECRET=*|TIKTOK_CLIENT_KEY=*|TIKTOK_CLIENT_SECRET=*) printf '%s\n' "$line" >> "$temporary_file" ;;
      esac
    elif [[ "$mode" == "twitch" ]]; then
      case "$line" in
        YOUTUBE_CLIENT_ID=*|YOUTUBE_CLIENT_SECRET=*|INSTAGRAM_CLIENT_ID=*|INSTAGRAM_CLIENT_SECRET=*|TIKTOK_CLIENT_KEY=*|TIKTOK_CLIENT_SECRET=*) printf '%s\n' "$line" >> "$temporary_file" ;;
      esac
    fi
  done < "$env_file"
fi
if [[ "$mode" == "twitch" ]]; then
  write_env_value TWITCH_CLIENT_ID "$TWITCH_CLIENT_ID"
  write_env_value TWITCH_CLIENT_SECRET "$TWITCH_CLIENT_SECRET"
fi
if [[ "$mode" == "youtube" ]]; then
  write_env_value YOUTUBE_CLIENT_ID "$YOUTUBE_CLIENT_ID"
  write_env_value YOUTUBE_CLIENT_SECRET "$YOUTUBE_CLIENT_SECRET"
fi
write_env_value SOCIAL_TOKEN_ENCRYPTION_KEY "$SOCIAL_TOKEN_ENCRYPTION_KEY"
write_env_value SOCIAL_SYNC_CRON_SECRET "$SOCIAL_SYNC_CRON_SECRET"
chmod 600 "$temporary_file"
mv "$temporary_file" "$env_file"
trap - EXIT

printf '%s\n' 'Uploading required secrets to the linked Supabase project...'
if ! supabase secrets set --env-file "$env_file" >/dev/null; then
  printf '%s\n' 'Secret upload failed. Your protected .env.social-accounts file was kept for retry.' >&2
  exit 1
fi
printf '%s\n' 'Deploying the social-accounts Edge Function…'
supabase functions deploy social-accounts --use-api
if [[ "$mode" == "twitch" ]]; then
  printf '%s\n' 'Twitch-only setup complete. Secret values were not displayed. The protected .env.social-accounts file remains local and is ignored by git.'
elif [[ "$mode" == "youtube" ]]; then
  printf '%s\n' 'YouTube-only setup complete. Secret values were not displayed. The protected .env.social-accounts file remains local and is ignored by git.'
else
  printf '%s\n' 'All-provider setup complete. Secret values were not displayed. The protected .env.social-accounts file remains local and is ignored by git.'
fi