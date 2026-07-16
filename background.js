// Leet2Git background service worker
// Receives scraped submission payloads from content_script.js and commits them
// to the user's configured GitHub repository via the Contents API.

const GITHUB_API = "https://api.github.com";

function sanitizeFilename(title) {
  // Keep it readable ("Two Sum.py") but strip characters invalid on most
  // filesystems / GitHub paths.
  return title
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getSettings() {
  const data = await chrome.storage.local.get([
    "githubToken", "repoOwner", "repoName", "branch", "folderPath"
  ]);
  return {
    token: data.githubToken || "",
    owner: data.repoOwner || "",
    repo: data.repoName || "",
    branch: data.branch || "main",
    folderPath: data.folderPath || "" // optional subfolder inside the repo
  };
}

function formatSubmissionBlock(payload) {
  const dt = new Date(payload.submittedAt);
  const readableDate = dt.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short"
  });

  const langLabel = payload.language.toUpperCase();

  return `
---

## Submission — ${readableDate} (${langLabel})

\`\`\`${payload.extension}
${payload.code}
\`\`\`
`;
}

function formatFullFileHeader(payload) {
  return `# ${payload.title}

## Problem Description

${payload.description}

## Examples

${payload.examples}

## Constraints

${payload.constraints || "_Not specified_"}
`;
}

// UTF-8 safe base64 encode/decode (plain atob/btoa mangle non-Latin1 chars,
// and the old escape/unescape trick is deprecated, so we go through
// TextEncoder/TextDecoder + byte arrays instead).
function b64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}
function b64DecodeUnicode(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function githubGetFile(settings, path) {
  const url = `${GITHUB_API}/repos/${settings.owner}/${settings.repo}/contents/${encodeURIComponent(path)}?ref=${settings.branch}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: "application/vnd.github+json"
    }
  });
  if (res.status === 404) return null; // file doesn't exist yet
  if (!res.ok) {
    throw new Error(`GitHub GET failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return {
    sha: data.sha,
    content: b64DecodeUnicode(data.content.replace(/\n/g, ""))
  };
}

async function githubPutFile(settings, path, content, sha, commitMessage) {
  const url = `${GITHUB_API}/repos/${settings.owner}/${settings.repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message: commitMessage,
    content: b64EncodeUnicode(content),
    branch: settings.branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return res;
}

async function commitSolution(payload) {
  const settings = await getSettings();
  if (!settings.token || !settings.owner || !settings.repo) {
    console.error("[Leet2Git] Missing GitHub settings. Open the extension popup to configure.");
    return { ok: false, error: "not_configured" };
  }

  // File itself is always Markdown (title/description/examples + fenced
  // code), regardless of solution language — only the code fence inside
  // uses payload.extension for syntax highlighting.
  const filename = `${sanitizeFilename(payload.title)}.md`;
  const path = settings.folderPath
    ? `${settings.folderPath.replace(/\/+$/, "")}/${filename}`
    : filename;

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let existing = null;
    try {
      existing = await githubGetFile(settings, path);
    } catch (e) {
      console.error("[Leet2Git] Error fetching existing file:", e);
      return { ok: false, error: "fetch_failed", detail: String(e) };
    }

    let newContent;
    let commitMessage;
    if (existing) {
      // Append below existing content, separated by the submission timestamp.
      newContent = existing.content.trimEnd() + "\n" + formatSubmissionBlock(payload);
      commitMessage = `Add new submission for ${payload.title} (${payload.language})`;
    } else {
      newContent = formatFullFileHeader(payload) + formatSubmissionBlock(payload);
      commitMessage = `Add solution for ${payload.title} (${payload.language})`;
    }

    const res = await githubPutFile(
      settings, path, newContent, existing ? existing.sha : null, commitMessage
    );

    if (res.ok) {
      return { ok: true, path };
    }
    if (res.status === 409 || res.status === 422) {
      // SHA conflict (someone/something else wrote in between) — retry with fresh SHA.
      continue;
    }
    const errText = await res.text();
    console.error(`[Leet2Git] GitHub PUT failed (${res.status}):`, errText);
    return { ok: false, error: "put_failed", status: res.status, detail: errText };
  }
  return { ok: false, error: "max_retries_exceeded" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "LEET2GIT_SCRAPE_FAILED") {
    if (chrome.notifications) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Leet2Git: Not archived ⚠️",
        message: `${message.reason}. LeetCode may have changed its page layout — see the console on the LeetCode tab for details.`
      });
    }
    return;
  }

  if (message.type === "LEET2GIT_SUBMISSION") {
    commitSolution(message.payload).then((result) => {
      const title = result.ok ? "Leet2Git: Saved ✅" : "Leet2Git: Failed ❌";
      const body = result.ok
        ? `${message.payload.title} archived to GitHub.`
        : `Could not save ${message.payload.title}: ${result.error}`;

      if (chrome.notifications) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title,
          message: body
        });
      }
      sendResponse(result);
    });
    return true; // keep the message channel open for the async response
  }
});
