# Family Expense Tracker – setup (about 10 minutes, one time)

Works on Android (Chrome) and iPhone (Safari). Both phones see one shared list, live.

## 1. Create a free Firebase project
1. Go to https://console.firebase.google.com → **Add project** (any name, e.g. `carrum-expenses`). Skip Google Analytics.
2. **Build → Firestore Database → Create database** → pick a region (e.g. `asia-south1` Mumbai) → **Production mode**.
3. Open the **Rules** tab, paste the contents of `firestore.rules`, click **Publish**.

## 2. Add the config to the app
1. Project settings (gear icon) → **Your apps** → click the **Web `</>`** icon → register app (no hosting).
2. Copy the `apiKey`, `authDomain`, `projectId`, `appId` values into `firebase-config.js`.
   (These values are not secrets; access is controlled by the rules and your family code.)

## 3. Put the app online (GitHub Pages)
1. Merge this branch into `main`.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. The *Deploy expense tracker* workflow runs; your URL will be
   `https://<your-username>.github.io/carrum-settlement-calculator/`.

## 4. Install on both phones
- **Motorola Edge 40 (Chrome):** open the URL → ⋮ menu → **Install app** / *Add to Home screen*.
- **iPhone 13 (Safari — must be Safari):** open the URL → Share button → **Add to Home Screen**.

## 5. Link the two phones
1. On your phone, open the app, enter your name and a long **family code** (e.g. `carrum-7k2x9-blue-tiger`).
2. Tap **Copy invite link**, send it to your wife on WhatsApp, and have her open it on her iPhone.
   She enters her name and she's connected to the same list.

## Notes
- Works offline; entries sync when the phone is back online.
- The family code is the only "password": keep it long and private.
- Each entry shows who added it.
