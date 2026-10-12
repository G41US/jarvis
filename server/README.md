# Jarvis proxy: no Groq key for your users

The app can't safely carry your Groq key: anyone can unpack an APK and read it.
This small Cloudflare Worker holds the key on Cloudflare's servers. The app talks to the Worker, and the Worker talks to Groq.

## Set it up (about 10 minutes, free to start)

1. Make a free account at dash.cloudflare.com.
2. Go to **Workers & Pages > Create > Create Worker**, name it `jarvis-proxy`, press **Deploy**, then **Edit code**.
   Replace everything with the contents of `worker.js` and press **Deploy** again.
3. Open the Worker's **Settings > Variables and Secrets** and add two **Secrets**:
   - `GROQ_API_KEY`: your Groq key
   - `APP_TOKEN`: any long random text (for example from a password generator). It stops other apps from using your Worker.
4. Copy the Worker's address, for example `https://jarvis-proxy.yourname.workers.dev`.
5. In GitHub, open the `jarvis` repo, then **Settings > Secrets and variables > Actions > New repository secret**, and add:
   - `JARVIS_API_BASE` = the Worker address followed by `/v1`, for example `https://jarvis-proxy.yourname.workers.dev/v1`
   - `JARVIS_APP_TOKEN` = the same text as `APP_TOKEN`
6. Run the **Build Jarvis APK** workflow again (Actions tab > Run workflow). That APK works without any key.

## Limit each phone (recommended before a public release)

In the Worker's **Settings > Bindings > Add > Rate limiting**, name it `LIMITER`, and allow for example 60 requests per 60 seconds.
The Worker uses it per phone automatically.

## Things to know before a public launch

- **Cost:** every user's questions and speech now run on your Groq account. The free tier is shared by everyone and runs out quickly,
  so move to Groq's paid plan and watch usage.
- **The app token is not a password:** it is inside the APK too, so it stops casual misuse, not a determined attacker.
  For a real launch, add sign-in (accounts, or Google Play Integrity) and check it in the Worker.
- **Allowed models:** only the models in `ALLOWED_MODELS` (default: gpt-oss-120b/20b, Llama 3.3 70B, Llama 3.1 8B, plus Whisper) can be used,
  and replies are capped at 2,000 tokens.
