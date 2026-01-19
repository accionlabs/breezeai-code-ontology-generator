#!/usr/bin/env node
/**
 * Java Import Analyzer
 * Can be used as a CLI tool or imported as a module
 *
 * CLI Usage: node file-tree-main-java.js <repoPath> <importsOutput.json>
 * Module Usage: const { analyzeJavaRepo } = require('./file-tree-main-java'); const data = await analyzeJavaRepo(repoPath);
 */

const { Worker } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const glob = require("glob");
const os = require("os");

// ---------- class index ----------
function buildJavaClassIndex(repoPath) {
  const index = {};

  const files = glob.sync("**/*.java", {
    cwd: repoPath,
    ignore: ["**/target/**", "**/build/**", "**/node_modules/**"]
  });

  for (const file of files) {
    const fqcn = file
      .replace(/\\/g, "/")
      .replace(/^.*?src\/[^/]+\/java\//, "")
      .replace(".java", "")
      .replace(/\//g, ".");

    index[fqcn] = file;
  }

  return index;
}

// -------------------------------------------------------------
// Main export function - to be called from main.js
// -------------------------------------------------------------
function analyzeJavaRepo(repoPath) {
  return new Promise((resolve, reject) => {
    console.log(`📂 Scanning Java repo: ${repoPath}`);

    const javaFiles = glob.sync(`${repoPath}/**/*.java`, {
      ignore: ["**/target/**", "**/build/**", "**/node_modules/**"]
    });

    const classIndex = buildJavaClassIndex(repoPath);

    const cpuCount = Math.max(1, os.cpus().length - 1);
    const chunkSize = Math.ceil(javaFiles.length / cpuCount);

    const results = [];
    let done = 0;
    const totalChunks = Math.ceil(javaFiles.length / chunkSize);

    if (javaFiles.length === 0) {
      console.log(`\n📊 Summary:`);
      console.log(`   Java files: 0`);
      resolve([]);
      return;
    }

    for (let i = 0; i < javaFiles.length; i += chunkSize) {
      const chunk = javaFiles.slice(i, i + chunkSize);

      const worker = new Worker(
        path.join(__dirname, "worker.js"),
        {
          workerData: {
            repoPath,
            files: chunk,
            classIndex
          }
        }
      );

      worker.on("message", data => {
        results.push(...data);
        done++;
        if (done === totalChunks) {
          console.log(`\n📊 Summary:`);
          console.log(`   Java files: ${results.length}`);
          resolve(results);
        }
      });

      worker.on("error", err => reject(err));
    }
  });
}

// Export the main function
module.exports = { analyzeJavaRepo };

// -------------------------------------------------------------
// CLI mode - only run if executed directly (not imported)
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node java/file-tree-main-java.js <repoPath> <importsOutput.json>"
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const outputPath = path.resolve(process.argv[3]);

  analyzeJavaRepo(repoPath)
    .then(results => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
      console.log("✅ Java analysis written to", outputPath);
    })
    .catch(err => {
      console.error("❌ Java analysis failed:", err);
      process.exit(1);
    });
}
