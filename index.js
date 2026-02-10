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

    const result = await autoDetectAndProcess(repoPath, outputDir, opts);
    if (!result.success) {
      process.exit(1);
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

function uploadToGenerate(filePath, apiKey, projectUuid, baseurl, opts) {
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
    const llmPlatform = opts.llmPlatform || "AWSBEDROCK";
    const uploadUrl = baseurl.replace(/\/+$/, "") + `/code-ontology/generate?llmPlatform=${llmPlatform}`;
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
      const result = await uploadToGenerate(filePath, apiKey, projectUuid, baseurl, opts);
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
