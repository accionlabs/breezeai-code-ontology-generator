const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const url = require("url");
const { autoDetectAndProcess, generateDescriptions, addMetadata } = require("./main");

const allowedLanguages = ["perl", "javascript", "python", "java", "typescript"];

async function run(opts) {
  const language = (opts.language || "").toLowerCase();
  const repoPath = path.resolve(opts.repo);
  const outputDir = path.resolve(opts.out);

  // If no language specified, use auto-detect mode via main.js
  if (!language) {
    console.log("🔍 No language specified - using auto-detect mode...\n");

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    if (opts.update) {
      console.log("\n🔄 Update mode: fetching existing file nodes...");
      try {
        const existingFileNodes = await fetchExistingFileNodes(opts.baseurl, opts.codeOntologyId, opts.userApiKey);

        // Build hash map from fetched nodes for file comparison
        const existingHashMap = {};
        for (const node of existingFileNodes) {
          if (node.path && node.fileHash) {
            existingHashMap[node.path] = node.fileHash;
          }
        }

        opts.existingHashMap = existingHashMap;
        // Store full node data for old-stats lookup after processing
        opts.existingFileNodes = existingFileNodes;
        console.log(`📊 Update mode: loaded ${Object.keys(existingHashMap).length} existing file hash(es) for comparison`);
      } catch (err) {
        console.error(`❌ Failed to fetch existing file nodes: ${err.message}`);
        process.exit(1);
      }

      // Step 1: Fetch existing project-level totals from code-ontology record
      console.log("📊 Update mode: fetching existing project metadata...");
      try {
        const existingMeta = await fetchCodeOntologyMetadata(opts.baseurl, opts.codeOntologyId, opts.userApiKey);
        opts.existingProjectMetadata = existingMeta;
        console.log(`✅ Existing project metadata: ${existingMeta.fileCount} files, ${existingMeta.functionCount} functions, ${existingMeta.classCount} classes, ${existingMeta.totalLinesOfCode} LOC`);
      } catch (err) {
        console.error(`❌ Failed to fetch existing project metadata: ${err.message}`);
        process.exit(1);
      }
    }

    const result = await autoDetectAndProcess(repoPath, outputDir, opts);
    if (!result.success) {
      process.exit(1);
    }

    // After mergeLanguageOutputs: correct project metadata using subtract-old/add-new
    if (opts.update && result.outputPath && opts.existingProjectMetadata) {
      console.log("\n📊 Update mode: correcting project metadata totals...");
      try {
        const outputJson = JSON.parse(fs.readFileSync(result.outputPath, "utf-8"));
        const changedFilePaths = (outputJson.files || []).map(f => f.path);
        const existingMeta = opts.existingProjectMetadata;

        if (changedFilePaths.length > 0) {
          // Step 2: Look up old stats for changed files from the already-fetched nodes
          const changedPathSet = new Set(changedFilePaths);
          const oldFileStats = (opts.existingFileNodes || []).filter(n => changedPathSet.has(n.path));

          // Step 3: Subtract old changed-file stats from project metadata
          let oldFunctions = 0, oldClasses = 0, oldLoc = 0, oldFileCount = 0;
          for (const stat of oldFileStats) {
            oldFunctions += stat.functionCount;
            oldClasses += stat.classCount;
            oldLoc += stat.loc;
            oldFileCount++;
          }

          const baselineFiles = existingMeta.fileCount - oldFileCount;
          const baselineFunctions = existingMeta.functionCount - oldFunctions;
          const baselineClasses = existingMeta.classCount - oldClasses;
          const baselineLoc = existingMeta.totalLinesOfCode - oldLoc;

          // Step 4: Add new stats from the analyzed output
          const newMeta = outputJson.projectMetaData;
          console.log(`📊 Changed files: ${changedFilePaths.length} (old: ${oldFileCount} files, ${oldFunctions} functions, ${oldClasses} classes, ${oldLoc} LOC; new: ${newMeta.totalFiles} files, ${newMeta.totalFunctions} functions, ${newMeta.totalClasses} classes, ${newMeta.totalLinesOfCode} LOC)`);
          outputJson.projectMetaData.totalFiles = baselineFiles + newMeta.totalFiles;
          outputJson.projectMetaData.totalFunctions = baselineFunctions + newMeta.totalFunctions;
          outputJson.projectMetaData.totalClasses = baselineClasses + newMeta.totalClasses;
          outputJson.projectMetaData.totalLinesOfCode = baselineLoc + newMeta.totalLinesOfCode;

          fs.writeFileSync(result.outputPath, JSON.stringify(outputJson, null, 2));
          console.log(`✅ Corrected metadata: ${outputJson.projectMetaData.totalFiles} files, ${outputJson.projectMetaData.totalFunctions} functions, ${outputJson.projectMetaData.totalClasses} classes, ${outputJson.projectMetaData.totalLinesOfCode} LOC`);
        } else {
          // No changed files — preserve existing project totals
          outputJson.projectMetaData.totalFiles = existingMeta.fileCount;
          outputJson.projectMetaData.totalFunctions = existingMeta.functionCount;
          outputJson.projectMetaData.totalClasses = existingMeta.classCount;
          outputJson.projectMetaData.totalLinesOfCode = existingMeta.totalLinesOfCode;
          fs.writeFileSync(result.outputPath, JSON.stringify(outputJson, null, 2));
          console.log("✅ No changed files — preserved existing project totals.");
        }
      } catch (err) {
        console.error(`❌ Failed to correct project metadata: ${err.message}`);
        process.exit(1);
      }
    }

    if (opts.upload) {
      await uploadGeneratedFiles(outputDir, opts);
    }
    return;
  }

  if (!allowedLanguages.includes(language)) {
    console.error(`❌ Invalid language. Allowed: ${allowedLanguages.join(", ")}`);
    process.exit(1);
  }

  if (!fs.existsSync(repoPath)) {
    console.error(`❌ Repo path does not exist: ${repoPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const importsOutput = path.join(outputDir, `${language}-imports.json`);

  const scriptMap = {
    perl: "file-tree-mapper.js",
    javascript: "nodejs/file-tree-mapper-nodejs.js",
    python: "python/file-tree-mapper-python.js",
    java: "java/file-tree-main-java.js",
    typescript: "typescript/file-tree-mapper-typescript.js",
  };

  if (language === "typescript") {
    console.log("\n📝 Note: TypeScript mode will also parse JavaScript files (.js, .jsx)");
  }

  const isWindows = process.platform === "win32";

  try {
    const scriptPath = path.resolve(__dirname, scriptMap[language]);
    const command = `node "${scriptPath}" "${repoPath}" "${importsOutput}"`;

    console.log("\n🚀 Running command:");
    console.log(command);

    execSync(command, { stdio: "inherit", shell: isWindows ? "cmd.exe" : undefined });

    console.log("✅ JSON tree generation finished!");
    console.log("📄 Output:", importsOutput);

    if (opts.generateDescriptions) {
      generateDescriptions(importsOutput, repoPath, opts, opts.verbose);
    }

    if (opts.addMetadata) {
      addMetadata(importsOutput, repoPath, opts, opts.verbose);
    }

    if (opts.upload) {
      await uploadGeneratedFiles(outputDir, opts);
    }

    console.log("\n🎉 All tasks completed successfully!");
    console.log("📄 Final output:", importsOutput);
  } catch (err) {
    console.error("❌ Failed:", err.message);
    process.exit(1);
  }
}

function uploadToGenerate(filePath, apiKey, projectUuid, baseurl) {
  return new Promise((resolve, reject) => {
    const boundary = `----FormBoundary${Date.now().toString(16)}`;
    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    // Read JSON to extract name from projectMetaData
    let name = fileName;
    try {
      const json = JSON.parse(fileContent.toString("utf-8"));
      if (json?.projectMetaData?.repositoryName) {
        name = json.projectMetaData.repositoryName;
      }
    } catch { }

    const parts = [];

    // file field
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: application/json\r\n\r\n`
      )
    );
    parts.push(fileContent);
    parts.push(Buffer.from(`\r\n`));

    // projectUuid field
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="projectUuid"\r\n\r\n` +
        `${projectUuid}\r\n`
      )
    );

    // name field
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="name"\r\n\r\n` +
        `${name}\r\n`
      )
    );

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const uploadUrl = baseurl.replace(/\/+$/, "") + "/code-ontology/generate?llmPlatform=AWSBEDROCK";
    const parsedUrl = url.parse(uploadUrl);
    const protocol = parsedUrl.protocol === "https:" ? https : http;

    const options = {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        "api-key": apiKey,
      },
    };

    const req = protocol.request(uploadUrl, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ statusCode: res.statusCode, body: parsed });
        } else {
          reject(
            new Error(`Upload failed for ${fileName}: HTTP ${res.statusCode} - ${data}`)
          );
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Network error uploading ${fileName}: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

function fetchExistingFileNodes(baseurl, codeOntologyId, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      params: { codeOntologyId: parseInt(codeOntologyId) },
      query: "MATCH (f:File) " +
        "OPTIONAL MATCH (f)-[:HAS_FUNCTION]->(fn:Function) " +
        "OPTIONAL MATCH (f)-[:HAS_CLASS]->(cl:Class) " +
        "RETURN {path: f.path, fileHash: f.fileHash, loc: f.loc} AS fileNode, " +
        "count(DISTINCT fn) AS functionCount, count(DISTINCT cl) AS classCount"
    });

    const endpoint = baseurl.replace(/\/+$/, "") + "/graph";
    const parsedUrl = url.parse(endpoint);
    const protocol = parsedUrl.protocol === "https:" ? https : http;

    const parseNeo4jInt = (val) => typeof val === "object" && val !== null ? (val.low || 0) : (val || 0);

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "api-key": apiKey,
      },
    };

    const req = protocol.request(endpoint, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            const fileNodes = (parsed.records || []).map(r => {
              const node = r._fields[0] || {};
              return {
                path: node.path,
                fileHash: node.fileHash,
                loc: parseNeo4jInt(node.loc),
                functionCount: parseNeo4jInt(r._fields[1]),
                classCount: parseNeo4jInt(r._fields[2]),
              };
            });
            console.log(`✅ Successfully fetched existing file nodes (HTTP ${res.statusCode})`);
            resolve(fileNodes);
          } catch (err) {
            console.error(`❌ Failed to parse existing file nodes JSON: ${err.message}`);
            reject(err);
          }
        } else {
          reject(
            new Error(`Failed to fetch existing file nodes: HTTP ${res.statusCode} - ${data}`)
          );
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Network error fetching file nodes: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}

function fetchCodeOntologyMetadata(baseurl, codeOntologyId, apiKey) {
  return new Promise((resolve, reject) => {
    console.log(`🔍 Fetching existing project metadata for codeOntologyId ${codeOntologyId}...`);
    const endpoint = baseurl.replace(/\/+$/, "") +
      `/code-ontology?filters[_id][$eq]=${codeOntologyId}`;
    const parsedUrl = url.parse(endpoint);
    const protocol = parsedUrl.protocol === "https:" ? https : http;

    const options = {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
    };

    const req = protocol.request(endpoint, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            const record = Array.isArray(parsed.data) ? parsed.data[0] : parsed;
            resolve({
              fileCount: record?.fileCount || 0,
              functionCount: record?.functionCount || 0,
              classCount: record?.classCount || 0,
              totalLinesOfCode: record?.totalLinesOfCode || 0,
            });
          } catch (err) {
            reject(new Error(`Failed to parse code-ontology metadata JSON: ${err.message}`));
          }
        } else {
          reject(new Error(`Failed to fetch code-ontology metadata: HTTP ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Network error fetching code-ontology metadata: ${err.message}`));
    });

    req.end();
  });
}

async function uploadGeneratedFiles(outputDir, opts) {
  const apiKey = opts.userApiKey;
  const projectUuid = opts.uuid;
  const baseurl = opts.baseurl;

  const jsonFiles = fs.readdirSync(outputDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(outputDir, f));

  if (jsonFiles.length === 0) {
    console.error("❌ No JSON files found in output directory to upload.");
    process.exit(1);
  }

  console.log(`\n📤 Uploading ${jsonFiles.length} file(s) to ${baseurl}/code-ontology/generate\n`);

  let successCount = 0;
  let failCount = 0;

  for (const filePath of jsonFiles) {
    const fileName = path.basename(filePath);
    try {
      process.stdout.write(`  Uploading ${fileName}...`);
      const result = await uploadToGenerate(filePath, apiKey, projectUuid, baseurl);
      console.log(` done (HTTP ${result.statusCode})`);
      successCount++;
    } catch (err) {
      console.log(` FAILED`);
      console.error(`    ${err.message}`);
      failCount++;
    }
  }

  console.log(`\nUpload complete: ${successCount} succeeded, ${failCount} failed`);
  if (failCount > 0) {
    process.exit(1);
  }
}

module.exports = { run };
