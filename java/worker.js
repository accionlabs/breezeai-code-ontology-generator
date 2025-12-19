const { isMainThread, workerData, parentPort } = require("worker_threads");

if (isMainThread) {
    console.error("❌ This file is a worker. Run file-tree-main.js instead.");
    process.exit(1);
}
const fs = require("fs");
const path = require("path");
const { extractFunctionsAndCalls, extractImports } = require("./extract-functions-java");
const { extractClasses } = require("./extract-classes-java");

const { repoPath, files, classIndex } = workerData;

// ---------- analyze file using extraction modules ----------
function analyzeFile(filePath) {
    try {
        const imports = extractImports(filePath, classIndex);
        const functions = extractFunctionsAndCalls(filePath, repoPath, classIndex);
        const classes = extractClasses(filePath, repoPath);

        return {
            path: path.relative(repoPath, filePath),
            importFiles: imports.importFiles,
            externalImports: imports.externalImports,
            functions,
            classes
        };
    } catch (error) {
        console.error(`Error analyzing ${filePath}:`, error.message);
        return null;
    }
}

// ---------- run ----------
const output = [];
for (const file of files) {
    const result = analyzeFile(file);
    if (result) {
        output.push(result);
    }
}

parentPort.postMessage(output);
