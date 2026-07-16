const els = {
  token: document.getElementById("token"),
  owner: document.getElementById("owner"),
  repo: document.getElementById("repo"),
  branch: document.getElementById("branch"),
  folder: document.getElementById("folder"),
  status: document.getElementById("status"),
  saveBtn: document.getElementById("saveBtn")
};

async function loadSettings() {
  const data = await chrome.storage.local.get([
    "githubToken", "repoOwner", "repoName", "branch", "folderPath"
  ]);
  if (data.githubToken) els.token.value = data.githubToken;
  if (data.repoOwner) els.owner.value = data.repoOwner;
  if (data.repoName) els.repo.value = data.repoName;
  if (data.branch) els.branch.value = data.branch;
  if (data.folderPath) els.folder.value = data.folderPath;
}

async function saveSettings() {
  const settings = {
    githubToken: els.token.value.trim(),
    repoOwner: els.owner.value.trim(),
    repoName: els.repo.value.trim(),
    branch: els.branch.value.trim() || "main",
    folderPath: els.folder.value.trim()
  };

  if (!settings.githubToken || !settings.repoOwner || !settings.repoName) {
    els.status.textContent = "Token, owner, and repo are required.";
    els.status.className = "error";
    return;
  }

  await chrome.storage.local.set(settings);
  els.status.textContent = "Settings saved ✓";
  els.status.className = "success";
}

els.saveBtn.addEventListener("click", saveSettings);
document.addEventListener("DOMContentLoaded", loadSettings);
