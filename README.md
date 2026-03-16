# Open Door Men's Retreat Golf Tournament Scorer

Live, multi-device golf scoring app for the Annual Open Door Men's Retreat.

Each team records individual scores per hole. The team's score for each hole is the **lowest score among the players on that team**. Lowest 18-hole total wins.

Scores sync in real time across all devices via Firebase. Concurrent score entry by multiple users is handled safely with per-cell database transactions. No accounts or logins required for scorers.

---

## One-Time Setup: Step-by-Step

### Step 1: Create a Firebase project

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com) and sign in with a Google account.
2. Click **Add project**. Name it anything (e.g. `od-golf-scorer`). Click through the prompts.
3. Once inside the project dashboard, click **Build** in the left sidebar, then **Realtime Database**.
4. Click **Create Database**.
   - Choose a region (United States is fine).
   - Select **Start in test mode**. Click **Enable**.

### Step 2: Get your Firebase config

1. Click the gear icon next to **Project Overview** in the top-left. Choose **Project settings**.
2. Scroll down to **Your apps**. If no web app is listed, click the **</>** (Web) icon. Name it anything. Do not check Firebase Hosting. Click **Register app**.
3. You will see a code block containing a `firebaseConfig` object like this:

```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

### Step 3: Add the config to the app

1. Open `index.html` in any text editor.
2. Find this block near the bottom of the file:

```js
const firebaseConfig = {
  apiKey:            "REPLACE_WITH_YOUR_API_KEY",
  authDomain:        "REPLACE_WITH_YOUR_AUTH_DOMAIN",
  databaseURL:       "REPLACE_WITH_YOUR_DATABASE_URL",
  ...
};
```

3. Replace each `REPLACE_WITH_...` value with the matching value from your Firebase config.

### Step 4: Set your admin PIN

In the same script block, find:

```js
const ADMIN_PIN = "1234";
```

Change `"1234"` to any PIN you want. This PIN clears all scores at the end of a round.

### Step 5: Push to GitHub

1. Go to [https://github.com/new](https://github.com/new) and create a new **public** repository (GitHub Pages requires public for free accounts). Name it anything, e.g. `od-golf`.
2. Do **not** initialize it with a README.
3. In your terminal, navigate to this folder and run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/od-golf.git
git push -u origin main
```

### Step 6: Enable GitHub Pages

1. In your GitHub repository, click **Settings**.
2. Click **Pages** in the left sidebar.
3. Under **Source**, choose **Deploy from a branch**. Select `main` and `/ (root)`. Click **Save**.
4. After about one minute, GitHub provides a URL like:

```
https://YOUR_USERNAME.github.io/od-golf/
```

Share that URL with all scorers. Anyone who opens it sees live scores.

---

## Each Year: Before the Tournament

1. Open the app URL.
2. Click the **Setup** tab.
3. Set the tournament name (e.g. "Men's Retreat 2027").
4. Add or remove teams as needed using the **+ Add Team** / **Remove Last** buttons.
5. Set the number of players per team using the dropdown.
6. Enter team names and player names in each team card.
7. Click **Save & Start Scoring**.

Setup changes sync live. If you start setup on your phone, someone else watching on a laptop sees it update in real time.

---

## During the Round: Scoring

- Click a team's tab.
- Enter each player's score for each hole. Any number from 1 to 20 is accepted.
- The lowest score among the players for that hole is highlighted in green and automatically counted as the team's score.
- Front nine, back nine, and total team scores update instantly.
- The **Leaderboard** tab shows all teams ranked by total score.

---

## After the Round: Reset for Next Year

1. Click **Admin** in the top-right corner.
2. Enter your PIN.
3. Click **Reset All Scores**.

All scores are cleared. Team names, player names, and tournament configuration are preserved so you only need to update what changed year to year.

---

## Updating After Changes

If you edit `index.html` after deployment, push the changes:

```bash
git add index.html
git commit -m "Update"
git push
```

GitHub Pages redeploys automatically within about one minute.

---

## Firebase Security (Optional, After the Event)

The default test mode allows any read or write. For an event that is one or two days, this is fine. After the event, you can lock it down in Firebase Console > Realtime Database > Rules:

```json
{
  "rules": {
    ".read": false,
    ".write": false
  }
}
```

Or to allow reads but no further writes:

```json
{
  "rules": {
    ".read": true,
    ".write": false
  }
}
```
