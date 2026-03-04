# Social Login Roadmap (Future)

## Goal
Add low-friction sign-in options for pilot scale-up:
- Sign in with Apple
- Google Sign-In
- Facebook Login

## Recommended architecture
- Mobile app obtains provider token.
- Backend validates token server-side.
- Backend issues first-party session token/JWT.
- App uses only first-party token for API calls.

## Why this approach
- Keeps provider secrets off-device.
- Allows one unified auth/session model for all providers.
- Makes future web/Telegram account linking cleaner.

## Phased rollout

### Phase A (first)
- Add `Sign in with Apple` only (best for iOS pilot users).
- Keep existing user linking by `telegram_id` optional.

### Phase B
- Add Google login.
- Add account-link flow in settings: link Telegram chat to app account.

### Phase C
- Add Facebook login if user demand justifies it.

## Backend endpoints to add (future)
- `POST /auth/apple`
- `POST /auth/google`
- `POST /auth/facebook`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/link-telegram`

## Data model additions (future)
- `auth_identities` table:
  - `user_id`, `provider`, `provider_user_id`, `email`, `created_at`
- `refresh_tokens` table:
  - `user_id`, `token_hash`, `expires_at`, `revoked_at`

## Security requirements
- Verify provider JWT signatures and audience.
- Hash refresh tokens at rest.
- Rotate/expire refresh tokens.
- Enforce per-user data isolation in every API handler.

## Product guidance
- For this pilot: keep auth optional/simple if users are known.
- Before open beta: add Apple login as mandatory baseline on iOS.
