#!/usr/bin/env node
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

// ---------- MAIN ----------
const repoPath = path.resolve(process.argv[2]);
const outputPath = path.resolve(process.argv[3]);

const javaFiles = glob.sync(`${repoPath}/**/*.java`, {
  ignore: ["**/target/**", "**/build/**", "**/node_modules/**"]
});

const classIndex = buildJavaClassIndex(repoPath);

const cpuCount = Math.max(1, os.cpus().length - 1);
const chunkSize = Math.ceil(javaFiles.length / cpuCount);

const results = [];
let done = 0;

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
    if (done === Math.ceil(javaFiles.length / chunkSize)) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
      console.log("✅ Java analysis written to", outputPath);
    }
  });

  worker.on("error", err => console.error(err));
}
