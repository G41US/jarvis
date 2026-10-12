# Jarvis proxy: no Groq key for your users

The app can't safely carry your Groq key: anyone can unpack an APK and read it.
This small Cloudflare Worker holds the key on Cloudflare's servers. The app talks to the Worker, and the Worker talks to Groq.

## Set it up (about 10 minutes, free to start)

GitHub deploys this for you every time the app builds. You only paste three values into GitHub once.

1. Make a free account at **dash.cloudflare.com**, then open **Workers & Pages** once. That gives your account its free
   `workers.dev` web address.
2. Still in Cloudflare: **My Profile > API Tokens > Create Token**, pick the template **Edit Cloudflare Workers**, then
   **Continue > Create Token**, and copy the token.
3. Copy your **Account ID** (Workers & Pages overview page, right-hand side).
4. In GitHub, open the `jarvis` repo: **Settings > Secrets and variables > Actions > New repository secret**. Add:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 3
   - `GROQ_API_KEY`: your Groq key
5. Open the **Actions** tab, then **Build Jarvis APK > Run workflow**. The build deploys the service and builds an app that
   needs no key: new users skip the key screen entirely.

Your Groq key stays on Cloudflare. It's never in the app, so nobody can pull it out of the APK.

## Limits

Each phone can make at most 60 requests a minute (set in `wrangler.toml`). Change `limit` there if needed.

## Things to know before a public launch

- **Cost:** every user's questions and speech now run on your Groq account. The free tier is shared by everyone and runs out quickly,
  so move to Groq's paid plan and watch usage.
- **The app's access token is not a password:** it's created automatically and lives inside the APK, so it stops casual
  misuse, not a determined attacker.
  For a real launch, add sign-in (accounts, or Google Play Integrity) and check it in the Worker.
- **Allowed models:** only the models in `ALLOWED_MODELS` (default: gpt-oss-120b/20b, Llama 3.3 70B, Llama 3.1 8B, plus Whisper) can be used,
  and replies are capped at 2,000 tokens.
