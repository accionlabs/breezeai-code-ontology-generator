const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  detectLanguages,
  processLanguage,
  mergeLanguageOutputs,
} = require("./main");
const { generateDescriptionsAsync, addMetadataAsync } = require("./llm-enrichment");
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
  if (!repoUrl || !incomingCommitId || !gitToken || !gitBranch || !projectUuid || !codeOntologyId) {
    return res.status(400).json({
      error:
        "All fields required: repoUrl, incomingCommitId, gitToken, gitBranch, projectUuid, codeOntologyId",
    });
  }

  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid GitHub repo URL" });
  }
  const { owner, repo } = parsed;

  // Treat "null", "undefined", empty string as no currentCommitId
  const hasCurrentCommit = currentCommitId && currentCommitId !== "null" && currentCommitId !== "undefined";

  try {
    // Fetch full directory tree at incomingCommitId for path resolution
    const tree = await githubApi(
      `/repos/${owner}/${repo}/git/trees/${incomingCommitId}?recursive=1`,
      gitToken
    );
    const skeletonPaths = (tree.tree || [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);

    let files = [];
    let deletedFiles = [];

    if (hasCurrentCommit) {
      // Compare the two commits
      const comparison = await githubApi(
        `/repos/${owner}/${repo}/compare/${currentCommitId}...${incomingCommitId}`,
        gitToken
      );

      const ghFiles = comparison.files || [];
      deletedFiles = ghFiles
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
    } else {
      // No currentCommitId — fetch all changes on the branch up to incomingCommitId
      // Get repo's default branch to use as the base for comparison

      console.log("No currentCommitId provided, fetching all files up to incomingCommitId on branch", gitBranch);
      const repoInfo = await githubApi(`/repos/${owner}/${repo}`, gitToken);
      const defaultBranch = repoInfo.default_branch;

      // List commits on the branch to find the very first commit
      const commits = await githubApi(
        `/repos/${owner}/${repo}/commits?sha=${incomingCommitId}&per_page=1`,
        gitToken
      );

      if (commits.length > 0) {
        let comparison;
        try {
          // Compare default branch with incomingCommitId to get all branch changes
          comparison = await githubApi(
            `/repos/${owner}/${repo}/compare/${defaultBranch}...${incomingCommitId}`,
            gitToken
          );
        } catch (_) {
          // If compare fails (e.g. branch IS the default branch or no common ancestor),
          // fall back to fetching all files from the tree
          comparison = null;
        }

        if (comparison && comparison.files && comparison.files.length > 0) {
          const ghFiles = comparison.files;
          deletedFiles = ghFiles
            .filter((f) => f.status === "removed")
            .map((f) => f.filename);
          const changedFiles = ghFiles.filter((f) => f.status !== "removed");

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
        } else {
          // Fallback: fetch all files from the tree at incomingCommitId
          const allBlobs = skeletonPaths;
          for (const blobPath of allBlobs) {
            try {
              const contentData = await githubApi(
                `/repos/${owner}/${repo}/contents/${encodeURIComponent(blobPath)}?ref=${incomingCommitId}`,
                gitToken
              );
              const content = Buffer.from(contentData.content, "base64").toString(
                "utf-8"
              );
              files.push({ path: blobPath, content });
            } catch (err) {
              console.warn(`Skipping binary/unreadable file: ${blobPath}`);
            }
          }
        }
      }

      if (files.length === 0) {
        return res.status(422).json({
          error: "No changed files found on the branch up to the specified commit",
        });
      }
    }

    const changedPaths = new Set(files.map((f) => f.path));
    const llmPlatform = req.query.llmPlatform || "AWSBEDROCK";
    const { output, tempDir } = await runAnalysis(files, repo, skeletonPaths, { keepTempDir: true });

    try {
      // Keep only changed files in the output, not skeleton placeholders
      if (output.files) {
        output.files = output.files.filter((f) => changedPaths.has(f.path));
      }

      // Write output to temp JSON file for description/metadata generation
      const outputJsonPath = path.join(tempDir, `${repo}-project-analysis.json`);
      fs.writeFileSync(outputJsonPath, JSON.stringify(output, null, 2));

      // Generate descriptions and metadata using the specified LLM platform
      const llmOpts = getLlmOpts(llmPlatform);
      // generateDescriptionsAsync(outputJsonPath, tempDir, llmOpts).then(async () => {
         const enrichedOutput = JSON.parse(fs.readFileSync(outputJsonPath, "utf-8"));

        enrichedOutput.deletedFiles = deletedFiles;
        enrichedOutput.projectUuid = projectUuid;
        enrichedOutput.codeOntologyId = codeOntologyId;
        enrichedOutput.projectMetaData.repoUrl = repoUrl;
        enrichedOutput.projectMetaData.gitBranch = gitBranch;
        enrichedOutput.projectMetaData.commitId = incomingCommitId;
        callHttp.httpPut(`${BREEZE_API_URL}/code-ontology/upsert?llmPlatform=${llmPlatform}`, enrichedOutput).then(() => {  }).catch((err) => {
          console.error("Error sending enriched ontology to Breeze API:", err);
        });
        console.log("Breeze API response sent");
        cleanupTempDir(tempDir);
      // }).catch((err) => { 
      //   console.error("Error generating descriptions or sending to Breeze API:", err);
      //   cleanupTempDir(tempDir);
      // });
      // await addMetadataAsync(outputJsonPath, tempDir, llmOpts);

      // Read back the enriched output
     

      res.json({ success: true, message: "Code ontology "+ "generated and sent to Breeze API for upsert. Enrichment is done asynchronously and may take additional time." });
    } catch (err) {
      throw err
    }
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
