const { isMainThread, workerData, parentPort } = require("worker_threads");

if (isMainThread) {
    console.error("❌ This file is a worker. Run file-tree-main.js instead.");
    process.exit(1);
}
const fs = require("fs");
const path = require("path");
const { extractFunctionsAndCalls, extractImports, extractFileStatements } = require("./extract-functions-java");
const { extractClasses } = require("./extract-classes-java");
const { extractFileRoutes } = require("./extract-routes-java");

const { repoPath, files, classIndex, captureSourceCode, captureStatements } = workerData;

// ---------- analyze file using extraction modules ----------
function analyzeFile(filePath) {
    try {
        const imports = extractImports(filePath, classIndex);
        const functions = extractFunctionsAndCalls(filePath, repoPath, classIndex, captureSourceCode, captureStatements);
        const classes = extractClasses(filePath, repoPath, captureStatements);

        const statements = captureStatements ? extractFileStatements(filePath) : [];

        // Detect Spring / JAX-RS routes and attach each to its handler method
        // (matched by name + startLine), mirroring the Python route convention.
        const routes = captureStatements ? extractFileRoutes(filePath) : [];
        if (routes.length) {
            routes.forEach(rt => {
                const fn = functions.find(
                    f => f.name === rt.handler && f.startLine === rt.handlerLine
                );
                if (fn) {
                    (fn.statements || (fn.statements = [])).push(rt);
                } else {
                    statements.push(rt); // fallback: file-level
                }
            });
        }

        return {
            path: path.relative(repoPath, filePath),
            importFiles: imports.importFiles,
            externalImports: imports.externalImports,
            functions,
            classes,
            statements
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
