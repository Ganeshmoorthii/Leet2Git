# Leet2Git

Automatically archives your accepted LeetCode solutions to a GitHub repo —
with the problem title, description, examples, constraints, and every
submission you've made for that problem (newest appended below, nothing
overwritten).

## How it works

1. A content script watches the LeetCode problem page for the green
   **Accepted** result.
2. On acceptance, it scrapes the problem statement (title / description /
   examples / constraints) and reads your submitted code straight out of the
   Monaco editor.
3. It sends that to the extension's background service worker, which talks to
   the GitHub Contents API to create or update `<Problem Title>.<ext>` in your
   configured repo.
4. If the file already exists, your new submission is appended below the
   existing content with a `---` divider and a timestamp — nothing is ever
   overwritten.

## Setup

### 1. Create a GitHub Personal Access Token

- Go to **GitHub → Settings → Developer settings → Personal access tokens →
  Fine-grained tokens** (or classic tokens).
- Scope it to just the one repo you want to archive into.
- Permissions needed: **Contents: Read and write**.
- Copy the token — you'll paste it into the extension popup (it's stored
  locally via `chrome.storage.local`, never sent anywhere except directly to
  `api.github.com`).

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `E:\Leet2Git` folder

### 3. Configure the extension

Click the Leet2Git icon in your toolbar and fill in:

- **GitHub Personal Access Token**
- **Repo Owner** — your GitHub username or org
- **Repo Name** — the repo you want solutions committed to
- **Branch** — usually `main`
- **Folder Path** (optional) — e.g. `solutions` if you want files nested in a
  subfolder instead of the repo root

Click **Save Settings**.

### 4. Solve a problem

Submit a solution on LeetCode. Once it's Accepted, you should get a
notification confirming it was archived, and the file will appear in your
GitHub repo within a few seconds.

## Known limitations (please read)

- **LeetCode's DOM markup isn't public/stable** — LeetCode periodically
  changes class names and layout. This extension avoids brittle CSS-class
  selectors where possible (using `data-*` attributes and text-based
  detection instead), but if LeetCode ships a redesign, the scraping logic
  in `content_script.js` may need small updates. If archiving silently stops
  working, that's the first place to check.
- **Contest/premium-only problems** may have slightly different DOM
  structure and aren't specifically tested.
- **Rapid repeated submissions** to the same problem within ~4 seconds are
  deduplicated client-side to avoid double-archiving the same accepted
  result from duplicate DOM mutation events.
- **First submission per problem** creates the file with the full problem
  statement; every submission after that only appends your new code (the
  statement isn't re-fetched/duplicated).

## File structure

```
Leet2Git/
├── manifest.json         MV3 manifest
├── background.js         GitHub API logic (create/append/retry)
├── content_script.js      Detection, scraping, and code extraction — runs on leetcode.com
├── popup.html/css/js      Settings UI
└── icons/                 Extension icons
```

## Technical note

LeetCode's code editor is **CodeMirror 6**, confirmed by inspecting the live
page. Code is read directly from the editor's DOM (`.cm-content > .cm-line`
elements). A Monaco-based fallback (`.monaco-editor .view-lines .view-line`)
is also checked in case a different surface (e.g. a mobile/legacy view) uses
it instead.
