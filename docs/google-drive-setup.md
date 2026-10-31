# Google Drive sign-in: one-time setup

The **Sign in with Google Drive** option needs a Google Cloud OAuth client. Without one, builds simply don't show it. You only do this once, for every build and platform.

1. **Project:** open <https://console.cloud.google.com/projectcreate>, name it `DeskPet`, and create it.
2. **Drive API:** open <https://console.cloud.google.com/apis/library/drive.googleapis.com> (with the DeskPet project selected) and click **Enable**.
3. **Branding:** Google Auth Platform → **Branding** (<https://console.cloud.google.com/auth/branding>): app name `DeskPet`, your support email, your developer contact email. Audience: **External**.
4. **Data access:** Google Auth Platform → **Data Access** → **Add or remove scopes**, tick these three, and save:
   - `.../auth/drive.appdata` (DeskPet's own hidden app-data space in Drive; it can't see any of your other files)
   - `openid`
   - `.../auth/userinfo.email` (shown in the panel as "Syncing through Google Drive (you@gmail.com)")
5. **Publish:** Google Auth Platform → **Audience** → **Publish app** → **In production**. In "Testing" status, sign-ins expire every 7 days and only listed test users can sign in. These scopes are non-sensitive, so publishing shouldn't need Google's review.
6. **Client:** Google Auth Platform → **Clients** → **Create client** → Application type **Desktop app**, name `DeskPet` → **Create** → **Download JSON**.
7. **Add it to the builds:**
   ```bash
   mv ~/Downloads/client_secret_*.json electron/src/google-oauth.json   # gitignored; build.sh bundles it on macOS
   gh secret set GOOGLE_OAUTH_JSON -R jacobsekai/deskpet < electron/src/google-oauth.json   # CI adds it to Windows/Linux builds
   ```

Google treats a desktop app's client secret as non-confidential (anyone can pull it out of the app), so it isn't a password. It stays out of the public repo anyway, so secret scanners don't flag it. Each person's sign-in token stays on their own computer: `~/.deskpet/google-account`, owner-only (on Windows and Linux it's also encrypted with the OS keychain when one is available).
