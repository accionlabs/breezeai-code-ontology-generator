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

function parseGitHubRepo(repoUrl) {
  const match = repoUrl.match(
    /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
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

/**
 * Resolve the Git diff between two commits via the GitHub API, fetch the
 * changed file contents one at a time, and write them to a temp dir.
 *
 * Used for incremental (re-)analysis when the repo has already been parsed
 * and we only need to process files that changed since `currentCommitId`.
 *
 * First-time analysis uses `cloneRepoFull()` below instead, to avoid the
 * per-file GitHub API rate limit.
 *
 * @returns {{ tempDir: string, filterSet: Set<string>, deletedFiles: string[] }}
 */
async function resolveGitDiff({ owner, repo, currentCommitId, incomingCommitId, gitToken }) {
  // Fetch full directory tree at incomingCommitId for path resolution
  const tree = await githubApi(
    `/repos/${owner}/${repo}/git/trees/${incomingCommitId}?recursive=1`,
    gitToken
  );
  const skeletonPaths = (tree.tree || [])
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path);

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
    const err = new Error("No changed files found between the two commits");
    err.statusCode = 422;
    err.deletedFiles = deletedFiles;
    throw err;
  }

  const changedFilePaths = changedFiles.map((cf) => cf.filename);

  // Write skeleton placeholders + fetch changed files to temp dir
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-"));
  console.log(`Temp directory created: ${tempDir}`);

  for (const sp of skeletonPaths) {
    const fullPath = path.join(tempDir, sp);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, "");
  }

  const filterSet = new Set();
  for (const filePath of changedFilePaths) {
    try {
      const contentData = await githubApi(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${incomingCommitId}`,
        gitToken
      );
      const content = Buffer.from(contentData.content, "base64").toString("utf-8");
      const fullPath = path.join(tempDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      filterSet.add(filePath);
    } catch (err) {
      console.warn(`Skipping binary/unreadable file: ${filePath}`);
    }
  }

  return { tempDir, filterSet, deletedFiles };
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
async function cloneRepoFull({ owner, repo, incomingCommitId, gitBranch, gitToken }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-clone-"));
  const authUrl = gitToken
    ? `https://x-access-token:${gitToken}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;

  const scrub = (s) =>
    String(s || "").replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");

  console.log(`Cloning ${owner}/${repo}@${gitBranch} into ${tempDir}`);

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

  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid GitHub repo URL" });
  }
  const { owner, repo } = parsed;

  try {
    const hasCurrentCommit =
      currentCommitId &&
      currentCommitId !== "null" &&
      currentCommitId !== "undefined";

    let tempDir;
    let filterSet;
    let deletedFiles;

    if (hasCurrentCommit) {
      // Repo already parsed — pull only the diff through the GitHub API.
      ({ tempDir, filterSet, deletedFiles } = await resolveGitDiff({
        owner, repo, currentCommitId, incomingCommitId, gitToken,
      }));
    } else {
      // First-time analysis — use `git clone` to bypass GitHub API rate limits.
      ({ tempDir } = await cloneRepoFull({
        owner, repo, incomingCommitId, gitBranch, gitToken,
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
