const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
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

    console.log("\n🎉 All tasks completed successfully!");
    console.log("📄 Final output:", importsOutput);
  } catch (err) {
    console.error("❌ Failed:", err.message);
    process.exit(1);
  }
}

module.exports = { run };
