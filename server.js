const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  detectLanguages,
  processLanguage,
  mergeLanguageOutputs,
} = require("./main");
const { analyzeConfigRepo } = require("./config/file-tree-mapper-config");
const { BREEZE_API_URL } = require("./app-config");
const callHttp = require("./call-http");

const app = express();
app.use(express.json({ limit: "50mb" }));

// --- Helpers ---

function parseGitHubRepo(repoUrl) {
  const match = repoUrl.match(
    /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

async function githubApi(endpoint, token) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res.json();
}

async function runAnalysis(files, projectName, skeletonPaths) {
  let tempDir;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-"));
    console.log(`Temp directory created: ${tempDir}`);

    // Create empty placeholder files so fs.existsSync resolves internal imports
    if (skeletonPaths && skeletonPaths.length > 0) {
      for (const sp of skeletonPaths) {
        const fullPath = path.join(tempDir, sp);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, "");
      }
    }

    // Write actual file contents (overwrites any skeleton placeholders)
    for (const f of files) {
      const fullPath = path.join(tempDir, f.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, f.content);
    }

    const detectedLanguages = detectLanguages(tempDir);
    if (detectedLanguages.length === 0) {
      const err = new Error("No supported languages detected in the provided files");
      err.statusCode = 422;
      throw err;
    }

    const results = [];
    for (const language of detectedLanguages) {
      const result = await processLanguage(language, tempDir);
      if (result) {
        results.push(result);
      }
    }

    if (results.length === 0) {
      throw new Error("All language analyzers failed");
    }

    try {
      const configData = analyzeConfigRepo(tempDir);
      if (configData && configData.length > 0) {
        results.push({
          language: "config",
          name: "Configuration Files",
          data: configData,
        });
      }
    } catch (_) {
      // Config analysis is optional, continue without it
    }

    const { data: output } = mergeLanguageOutputs(results, tempDir, tempDir);

    const name = projectName || "untitled-project";
    output.projectMetaData.repositoryPath = name;
    output.projectMetaData.repositoryName = name;

    return output;
  } finally {
    if (tempDir) {
      console.log(`Cleaning up temp directory: ${tempDir}`);
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {
        // best-effort cleanup
      }
    }
  }
}

// --- Routes ---

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Main analysis endpoint
app.post("/api/analyze", async (req, res) => {
  const { files, projectName } = req.body;

  if (!Array.isArray(files) || files.length === 0) {
    return res
      .status(400)
      .json({ error: "\"files\" must be a non-empty array" });
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
      return res.status(400).json({
        error: `files[${i}] must have "path" (string) and "content" (string)`,
      });
    }
    if (f.path.includes("..")) {
      return res
        .status(400)
        .json({ error: `files[${i}].path must not contain ".."` });
    }
  }

  try {
    const output = await runAnalysis(files, projectName);
    res.json(output);
  } catch (err) {
    console.error("Analysis error:", err);
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

// Git diff analysis endpoint
app.post("/api/analyze-diff", async (req, res) => {
  const { repoUrl, currentCommitId, incomingCommitId, gitToken, gitBranch, projectUuid, codeOntologyId } =
    req.body;

  // Validate required fields
  if (!repoUrl || !currentCommitId || !incomingCommitId || !gitToken || !gitBranch || !projectUuid) {
    return res.status(400).json({
      error:
        "All fields required: repoUrl, currentCommitId, incomingCommitId, gitToken, gitBranch, projectUuid",
    });
  }

  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid GitHub repo URL" });
  }
  const { owner, repo } = parsed;

  try {
    // Fetch full directory tree at incomingCommitId for path resolution
    const tree = await githubApi(
      `/repos/${owner}/${repo}/git/trees/${incomingCommitId}?recursive=1`,
      gitToken
    );
    const skeletonPaths = (tree.tree || [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);

    // Compare the two commits
    const comparison = await githubApi(
      `/repos/${owner}/${repo}/compare/${currentCommitId}...${incomingCommitId}`,
      gitToken
    );

    const ghFiles = comparison.files || [];
    const deletedFiles = ghFiles
      .filter((f) => f.status === "removed")
      .map((f) => f.filename);
    const changedFiles = ghFiles.filter((f) => f.status !== "removed");

    if (changedFiles.length === 0) {
      return res.status(422).json({
        error: "No changed files found between the two commits",
        deletedFiles,
      });
    }

    // Fetch content for each changed file
    const files = [];
    for (const cf of changedFiles) {
      const contentData = await githubApi(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(cf.filename)}?ref=${incomingCommitId}`,
        gitToken
      );
      const content = Buffer.from(contentData.content, "base64").toString(
        "utf-8"
      );
      files.push({ path: cf.filename, content });
    }

    const changedPaths = new Set(files.map((f) => f.path));
    const output = await runAnalysis(files, repo, skeletonPaths);

    // Keep only changed files in the output, not skeleton placeholders
    if (output.files) {
      output.files = output.files.filter((f) => changedPaths.has(f.path));
    }

    output.deletedFiles = deletedFiles;
    output.projectUuid = projectUuid;
    output.codeOntologyId = codeOntologyId;
    output.projectMetaData.repoUrl = repoUrl;
    output.projectMetaData.gitBranch = gitBranch;
    output.projectMetaData.commitId = incomingCommitId;
    const httpRes = await callHttp.httpPut(`${BREEZE_API_URL}/code-ontology/upsert?llmPlatform=${req.query.llmPlatform || 'AWSBEDROCK'}`, output);
    res.json(httpRes);
  } catch (err) {
    console.error("Analyze-diff error:", err);
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

function startServer(port) {
  const p = port || process.env.PORT || 3000;
  app.listen(p, () => {
    console.log(`Breeze Code Ontology Generator API listening on port ${p}`);
  });
}

// Run directly
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
