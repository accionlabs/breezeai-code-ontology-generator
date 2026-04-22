const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const {
  detectLanguages,
  processLanguage,
  mergeLanguageOutputs,
  mergeProjectMetaData,
  assembleOutputFromNdjson,
} = require("./main");
const { generateDescriptionsAsync, addMetadataAsync } = require("./llm-enrichment");
const { analyzeConfigRepo } = require("./config/file-tree-mapper-config");
const { BREEZE_API_URL } = require("./app-config");
const callHttp = require("./call-http");
const { createS3UploadStream } = require("./s3-upload");

const app = express();
app.use(express.json({ limit: "50mb" }));

// --- Helpers ---

function parseRepoUrl(repoUrl) {
  const gh = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (gh) return { provider: "github", owner: gh[1], repo: gh[2] };

  const bb = repoUrl.match(/bitbucket\.org\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (bb) return { provider: "bitbucket", owner: bb[1], repo: bb[2] };

  return null;
}

function bitbucketAuthHeader(credential) {
  if (!credential) return null;
  // Bitbucket auth uses API keys via Basic auth. Credential format is
  // "username:api_key" (or "email:api_token" for Atlassian API tokens).
  if (!credential.includes(":")) {
    const err = new Error(
      'Bitbucket credential must be in "username:api_key" format (API key via Basic auth).'
    );
    err.statusCode = 400;
    throw err;
  }
  return `Basic ${Buffer.from(credential).toString("base64")}`;
}

async function githubApi(endpoint, token) {
  const headers = { Accept: "application/vnd.github.v3+json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`https://api.github.com${endpoint}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res.json();
}

async function bitbucketApi(endpointOrUrl, token) {
  const headers = { Accept: "application/json" };
  const auth = bitbucketAuthHeader(token);
  if (auth) headers.Authorization = auth;
  const url = endpointOrUrl.startsWith("http")
    ? endpointOrUrl
    : `https://api.bitbucket.org${endpointOrUrl}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bitbucket API ${res.status}: ${body}`);
  }
  return res.json();
}

async function bitbucketRawFile({ owner, repo, filePath, commitId, gitToken }) {
  const headers = {};
  const auth = bitbucketAuthHeader(gitToken);
  if (auth) headers.Authorization = auth;
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/src/${commitId}/${encodedPath}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bitbucket src ${res.status}: ${body}`);
  }
  return res.text();
}

function buildAuthCloneUrl({ provider, owner, repo, gitToken }) {
  if (provider === "github") {
    return gitToken
      ? `https://x-access-token:${gitToken}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;
  }
  if (provider === "bitbucket") {
    if (!gitToken) return `https://bitbucket.org/${owner}/${repo}.git`;
    // API key via Basic auth — credential must be "username:api_key".
    if (!gitToken.includes(":")) {
      const err = new Error(
        'Bitbucket credential must be in "username:api_key" format (API key via Basic auth).'
      );
      err.statusCode = 400;
      throw err;
    }
    const colonIdx = gitToken.indexOf(":");
    const user = gitToken.slice(0, colonIdx);
    const pass = gitToken.slice(colonIdx + 1);
    return `https://x-bitbucket-api-token-auth:${pass}@bitbucket.org/${owner}/${repo}.git`;
  }
  throw new Error(`Unsupported git provider: ${provider}`);
}

async function runAnalysis(files, projectName, skeletonPaths, { keepTempDir = false } = {}) {
  let tempDir;
  let shouldCleanup = true;
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

    // NDJSON mode: process each language incrementally to avoid holding all data in memory.
    // Each language result is written to NDJSON and discarded before the next language loads.
    const ndjsonFilePath = path.join(tempDir, 'files.ndjson');
    console.log(`Using NDJSON file for incremental output: ${ndjsonFilePath}`);
    fs.writeFileSync(ndjsonFilePath, ''); // Initialize empty NDJSON file

    let accumulatedMetaData = null;
    let successCount = 0;

    for (const language of detectedLanguages) {
      const result = await processLanguage(language, tempDir);
      if (result) {
        successCount++;
        const { projectMetaData } = mergeLanguageOutputs([result], tempDir, tempDir, ndjsonFilePath);
        accumulatedMetaData = accumulatedMetaData
          ? mergeProjectMetaData(accumulatedMetaData, projectMetaData)
          : projectMetaData;
        // result.data is no longer referenced — GC can reclaim before next iteration
      }
    }

    if (successCount === 0) {
      throw new Error("All language analyzers failed");
    }

    // Config analysis (optional)
    try {
      const configData = analyzeConfigRepo(tempDir);
      if (configData && configData.length > 0) {
        const { projectMetaData } = mergeLanguageOutputs(
          [{ language: "config", name: "Configuration Files", data: configData }],
          tempDir, tempDir, ndjsonFilePath
        );
        accumulatedMetaData = accumulatedMetaData
          ? mergeProjectMetaData(accumulatedMetaData, projectMetaData)
          : projectMetaData;
      }
    } catch (_) {
      // Config analysis is optional, continue without it
    }

    const name = projectName || "untitled-project";
    accumulatedMetaData.repositoryPath = name;
    accumulatedMetaData.repositoryName = name;

    // Assemble final JSON from NDJSON
    const outputPath = path.join(tempDir, `${path.basename(tempDir)}-project-analysis.json`);
    const output = assembleOutputFromNdjson(ndjsonFilePath, accumulatedMetaData, outputPath);

    if (keepTempDir) {
      shouldCleanup = false;
      return { output, tempDir };
    }
    return { output };
  } finally {
    if (tempDir && shouldCleanup) {
      console.log(`Cleaning up temp directory: ${tempDir}`);
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {
        // best-effort cleanup
      }
    }
  }
}

function cleanupTempDir(tempDir) {
  if (tempDir) {
    console.log(`Cleaning up temp directory: ${tempDir}`);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
      // best-effort cleanup
    }
  }
}

function getLlmOpts(llmPlatform) {
  const {
    OPENAI_API_KEY,
    CLAUDE_API_KEY,
    GEMINI_API_KEY,
    AWS_ACCESS_KEY,
    AWS_SECRET_KEY,
    AWS_REGION,
  } = require("./app-config");

  const platformMap = {
    OPENAI: { provider: "openai", apiKey: OPENAI_API_KEY },
    CLAUDE: { provider: "claude", apiKey: CLAUDE_API_KEY },
    ANTHROPIC: { provider: "claude", apiKey: CLAUDE_API_KEY },
    GEMINI: { provider: "gemini", apiKey: GEMINI_API_KEY },
    AWSBEDROCK: { provider: "bedrock", awsAccessKey: AWS_ACCESS_KEY, awsSecretKey: AWS_SECRET_KEY, awsRegion: AWS_REGION },
  };

  const platform = (llmPlatform || "AWSBEDROCK").toUpperCase();
  return platformMap[platform] || platformMap.AWSBEDROCK;
}

// --- Provider-specific tree / compare / content fetchers ---

async function ghTree({ owner, repo, commitId, gitToken }) {
  const tree = await githubApi(
    `/repos/${owner}/${repo}/git/trees/${commitId}?recursive=1`,
    gitToken
  );
  return (tree.tree || []).filter((e) => e.type === "blob").map((e) => e.path);
}

async function ghCompare({ owner, repo, currentCommitId, incomingCommitId, gitToken }) {
  const cmp = await githubApi(
    `/repos/${owner}/${repo}/compare/${currentCommitId}...${incomingCommitId}`,
    gitToken
  );
  const files = cmp.files || [];
  return {
    deleted: files.filter((f) => f.status === "removed").map((f) => f.filename),
    changed: files.filter((f) => f.status !== "removed").map((f) => f.filename),
  };
}

async function ghContent({ owner, repo, filePath, commitId, gitToken }) {
  const data = await githubApi(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${commitId}`,
    gitToken
  );
  return Buffer.from(data.content, "base64").toString("utf-8");
}

async function bbTree({ owner, repo, commitId, gitToken }) {
  // Bitbucket's src endpoint with max_depth gives a recursive listing across
  // pages. Filter to commit_file (blobs) only.
  const paths = [];
  let next =
    `/2.0/repositories/${owner}/${repo}/src/${commitId}/` +
    `?pagelen=100&max_depth=100`;
  while (next) {
    const page = await bitbucketApi(next, gitToken);
    for (const entry of page.values || []) {
      if (entry.type === "commit_file" && entry.path) paths.push(entry.path);
    }
    next = page.next || null;
  }
  return paths;
}

async function bbCompare({ owner, repo, currentCommitId, incomingCommitId, gitToken }) {
  // Bitbucket diffstat spec is `{destination}..{source}` — using
  // `{incoming}..{current}` mirrors GitHub's `compare/{base}...{head}`:
  // status "removed" = file existed in current but not in incoming.
  const deleted = [];
  const changed = [];
  let next =
    `/2.0/repositories/${owner}/${repo}/diffstat/` +
    `${incomingCommitId}..${currentCommitId}?pagelen=100`;
  while (next) {
    const page = await bitbucketApi(next, gitToken);
    for (const entry of page.values || []) {
      const newPath = entry.new && entry.new.path;
      const oldPath = entry.old && entry.old.path;
      if (entry.status === "removed" && oldPath) {
        deleted.push(oldPath);
      } else if (newPath) {
        changed.push(newPath);
        if (entry.status === "renamed" && oldPath && oldPath !== newPath) {
          deleted.push(oldPath);
        }
      }
    }
    next = page.next || null;
  }
  return { deleted, changed };
}

async function bbContent({ owner, repo, filePath, commitId, gitToken }) {
  return bitbucketRawFile({ owner, repo, filePath, commitId, gitToken });
}

function providerApi(provider) {
  if (provider === "github") return { tree: ghTree, compare: ghCompare, content: ghContent };
  if (provider === "bitbucket") return { tree: bbTree, compare: bbCompare, content: bbContent };
  throw new Error(`Unsupported git provider: ${provider}`);
}

/**
 * Resolve the Git diff between two commits via the provider's REST API,
 * fetch the changed file contents one at a time, and write them to a temp
 * dir. Used for incremental (re-)analysis when the repo has already been
 * parsed and we only need to process files that changed since `currentCommitId`.
 *
 * First-time analysis uses `cloneRepoFull()` below instead, to avoid the
 * per-file API rate limits.
 *
 * @returns {{ tempDir: string, filterSet: Set<string>, deletedFiles: string[] }}
 */
async function resolveGitDiff({ provider, owner, repo, currentCommitId, incomingCommitId, gitToken }) {
  const api = providerApi(provider);

  const skeletonPaths = await api.tree({ owner, repo, commitId: incomingCommitId, gitToken });
  const { changed, deleted } = await api.compare({
    owner, repo, currentCommitId, incomingCommitId, gitToken,
  });

  if (changed.length === 0) {
    const err = new Error("No changed files found between the two commits");
    err.statusCode = 422;
    err.deletedFiles = deleted;
    throw err;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-"));
  console.log(`Temp directory created: ${tempDir}`);

  for (const sp of skeletonPaths) {
    const fullPath = path.join(tempDir, sp);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, "");
  }

  const filterSet = new Set();
  for (const filePath of changed) {
    try {
      const content = await api.content({
        owner, repo, filePath, commitId: incomingCommitId, gitToken,
      });
      const fullPath = path.join(tempDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      filterSet.add(filePath);
    } catch (err) {
      console.warn(`Skipping binary/unreadable file: ${filePath}`);
    }
  }

  return { tempDir, filterSet, deletedFiles: deleted };
}

function countFilesExcludingGit(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) count++;
    }
  }
  return count;
}

/**
 * Clone the full repo at the given branch into a temp dir and check out
 * `incomingCommitId`. Used for first-time analysis so we don't have to
 * fetch every file through the GitHub API (which rate-limits quickly).
 *
 * The token, if provided, is injected only into the URL passed to `git`
 * and is scrubbed from any error output before it leaves this function.
 *
 * @returns {{ tempDir: string }}
 */
async function cloneRepoFull({ provider, owner, repo, incomingCommitId, gitBranch, gitToken }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-clone-"));
  // Scrub any embedded credentials before they hit logs/error messages.
  const scrub = (s) =>
    String(s || "").replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//***:***@");

  const authUrl = buildAuthCloneUrl({ provider, owner, repo, gitToken });
  console.log(`Cloning ${provider}:${owner}/${repo}@${gitBranch} into ${tempDir}, authUrl: ${scrub(authUrl)}`);

  try {
    execFileSync(
      "git",
      ["clone", "--branch", gitBranch, "--single-branch", authUrl, tempDir],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    const afterCloneCount = countFilesExcludingGit(tempDir);
    console.log(`Clone complete — ${afterCloneCount} files on branch ${gitBranch}`);

    // Check out the requested commit (usually HEAD of the branch — this is a
    // no-op in that case, but covers requests for an older commit on-branch).
    if (incomingCommitId) {
      execFileSync("git", ["-C", tempDir, "checkout", "--quiet", incomingCommitId], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      const afterCheckoutCount = countFilesExcludingGit(tempDir);
      console.log(
        `Checked out ${incomingCommitId} — ${afterCheckoutCount} files on disk`
      );
    }
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`git clone failed: ${scrub(stderr || err.message)}`);
  }

  // Drop .git — parser doesn't need it, and it would inflate detectLanguages/walks.
  try {
    fs.rmSync(path.join(tempDir, ".git"), { recursive: true, force: true });
  } catch (_) {
    // best-effort
  }

  return { tempDir };
}

/**
 * Streaming analysis for diff mode: writes NDJSON.gz directly to S3.
 * No local JSON assembly — each file node streams through gzip to S3.
 *
 * Expects a pre-populated tempDir from resolveGitDiff().
 */
async function runAnalysisDiffStream({ tempDir, filterSet, s3Key, repo }) {
  try {
    // filterSet is a Set<string> in incremental (API-diff) mode — restrict which
    // files' records are written. In full-clone mode it's null/undefined, meaning
    // "emit every parsed file" (mergeLanguageOutputs treats falsy filterPaths as
    // no filter).
    if (filterSet && filterSet.size === 0) {
      const err = new Error("No readable files could be fetched from GitHub");
      err.statusCode = 422;
      throw err;
    }

    const detectedLanguages = detectLanguages(tempDir);
    if (detectedLanguages.length === 0) {
      const err = new Error("No supported languages detected in the provided files");
      err.statusCode = 422;
      throw err;
    }

    // Create S3 streaming pipeline
    const { passThrough, uploadPromise } = createS3UploadStream(s3Key);
    console.log(`Streaming NDJSON.gz to S3: ${s3Key}`);

    let accumulatedMetaData = null;
    let successCount = 0;

    for (const language of detectedLanguages) {
      const result = await processLanguage(language, tempDir);
      if (result) {
        successCount++;
        const { projectMetaData } = mergeLanguageOutputs([result], tempDir, tempDir, passThrough, filterSet);
        accumulatedMetaData = accumulatedMetaData
          ? mergeProjectMetaData(accumulatedMetaData, projectMetaData)
          : projectMetaData;
        // result.data is no longer referenced — GC can reclaim before next iteration
      }
    }

    if (successCount === 0) {
      passThrough.end();
      throw new Error("All language analyzers failed");
    }

    // Config analysis (optional)
    try {
      const configData = analyzeConfigRepo(tempDir);
      if (configData && configData.length > 0) {
        const { projectMetaData } = mergeLanguageOutputs(
          [{ language: "config", name: "Configuration Files", data: configData }],
          tempDir, tempDir, passThrough, filterSet
        );
        accumulatedMetaData = accumulatedMetaData
          ? mergeProjectMetaData(accumulatedMetaData, projectMetaData)
          : projectMetaData;
      }
    } catch (_) {
      // Config analysis is optional, continue without it
    }

    const name = repo || "untitled-project";
    accumulatedMetaData.repositoryPath = name;
    accumulatedMetaData.repositoryName = name;

    // Signal end of stream — flushes gzip and completes S3 multipart upload
    passThrough.end();
    await uploadPromise;

    return { projectMetaData: accumulatedMetaData };
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
    const { output } = await runAnalysis(files, projectName);
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
  if (!repoUrl || !incomingCommitId || !gitBranch || !projectUuid || !codeOntologyId) {
    return res.status(400).json({
      error:
        "All fields required: repoUrl, incomingCommitId, gitBranch, projectUuid, codeOntologyId",
    });
  }

  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) {
    return res.status(400).json({
      error: "Invalid repo URL (supported hosts: github.com, bitbucket.org)",
    });
  }
  const { provider, owner, repo } = parsed;

  try {
    const hasCurrentCommit =
      currentCommitId &&
      currentCommitId !== "null" &&
      currentCommitId !== "undefined";

    let tempDir;
    let filterSet;
    let deletedFiles;

    if (hasCurrentCommit) {
      // Repo already parsed — pull only the diff through the provider API.
      ({ tempDir, filterSet, deletedFiles } = await resolveGitDiff({
        provider, owner, repo, currentCommitId, incomingCommitId, gitToken,
      }));
    } else {
      // First-time analysis — use `git clone` to bypass provider API rate limits.
      ({ tempDir } = await cloneRepoFull({
        provider, owner, repo, incomingCommitId, gitBranch, gitToken,
      }));
      filterSet = null;   // process every file in the repo
      deletedFiles = [];
    }

    const llmPlatform = req.query.llmPlatform || "AWSBEDROCK";
    const s3Key = `code-ontology/${projectUuid}/${incomingCommitId}.ndjson.gz`;

    const { projectMetaData } = await runAnalysisDiffStream({
      tempDir, filterSet, s3Key, repo,
    });

    projectMetaData.repoUrl = repoUrl;
    projectMetaData.gitBranch = gitBranch;
    projectMetaData.commitId = incomingCommitId;

    // POST lightweight notification with S3 key + metadata
    callHttp.httpPost(
      `${BREEZE_API_URL}/code-ontology/stream-ingest?llmPlatform=${llmPlatform}`,
      {
        s3Key,
        projectMetaData,
        deletedFiles,
        projectUuid,
        codeOntologyId,
        repoUrl,
        gitBranch,
        commitId: incomingCommitId,
        llmPlatform,
      }
    ).then(() => {
      console.log("stream-ingest notification sent to Breeze API");
    }).catch((err) => {
      console.error("Error sending stream-ingest notification to Breeze API:", err);
    });

    res.json({
      success: true,
      s3Key,
      message: "Code ontology streamed to S3 and notification sent to Breeze API for ingestion.",
    });
  } catch (err) {
    console.error("Analyze-diff error:", err);
    const status = err.statusCode || 500;
    const body = { error: err.message };
    if (err.deletedFiles) body.deletedFiles = err.deletedFiles;
    res.status(status).json(body);
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
