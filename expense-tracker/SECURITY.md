# Security notes – Family Expense Tracker

## What protects your data
| Layer | What it does |
|---|---|
| **Family code** | The only "password". Anyone who has it can read, add and delete entries. Use the app's **Generate a strong code** button (about 100 bits, impossible to guess). Share it only in a private chat. |
| **Firestore rules** (`firestore.rules`) | Only `families/<code>/expenses` and `families/<code>/budgets` are reachable; the code must be 8–60 characters; every document must have exactly the expected fields, types, lengths and a valid date; nothing else in the database can be read or written. Tested on the Firebase emulator (38 checks). |
| **Content Security Policy** | The page may run scripts only from itself and `www.gstatic.com` (Firebase SDK), and may talk only to Firestore. Injected inline scripts, event handlers and calls to other sites are blocked. |
| **Output escaping** | Every value that comes from the database is HTML-escaped before it is shown. |
| **CSV export** | Cells starting with `= + - @` are neutralised so a malicious note cannot run as a spreadsheet formula. |
| **Anti-framing** | The app blanks itself if another website embeds it (clickjacking). |
| **No secrets in the repo** | The Firebase web config is public by design. The repo and its full history were scanned: no tokens or private keys. |

## Do these once (they cannot be done from code)
1. **Turn on 2-step verification (passkey or authenticator app) for your GitHub and Google accounts.**
   Whoever controls those accounts could change the app or the database. This is the biggest real-world risk.
2. **Restrict the Firebase API key to your website** (stops other sites from using your project):
   Google Cloud Console → select project *Monthly Tracker* → **APIs & Services → Credentials** →
   open the **Browser key** → *Application restrictions*: **Websites** → add `https://adarshkumar-byte.github.io/*` →
   *API restrictions*: **Restrict key** → tick **Cloud Firestore API** → **Save**.
   Wait a few minutes, then open the app and add a test entry. If it shows *Sync error*, remove the restriction (it is optional).
3. **Re-publish `firestore.rules`** in Firebase console → Firestore Database → Rules whenever it changes.
4. **Back up every month:** *Backup all data (CSV)*. Anyone with the family code can delete entries, so keep a copy.

## Good habits
- Never post the invite link in a group, a screenshot or social media. If it leaks, make a new code in **Settings** and tell Kajal.
- Keep phone software updated and install only apps from the official stores; malware on a phone can read anything shown on it, and no website can prevent that.
- GitHub Pages serves every project of your account from `adarshkumar-byte.github.io`, so those pages share browser storage. Do not host pages you do not trust under the same account.

## Known limits (honest list)
- The Firebase SDK is loaded from Google's CDN at a fixed version. Browsers cannot verify a hash for that kind of import.
- There are no individual user logins: the family code is shared. If you want per-person logins and the ability to remove one person, ask for Firebase Authentication.
- Firestore has no per-IP rate limiting. Someone who guesses a code could add junk entries (limited in size and shape by the rules). The free Spark plan cannot charge you.
