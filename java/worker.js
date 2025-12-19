const { isMainThread, workerData, parentPort } = require("worker_threads");

if (isMainThread) {
    console.error("❌ This file is a worker. Run file-tree-main.js instead.");
    process.exit(1);
}
const fs = require("fs");
const path = require("path");
const Parser = require("tree-sitter");
const Java = require("tree-sitter-java");

const parser = new Parser();
parser.setLanguage(Java);

const { repoPath, files, classIndex } = workerData;

// ---------- helpers ----------
function traverse(node, cb) {
    cb(node);
    for (let i = 0; i < node.namedChildCount; i++) {
        traverse(node.namedChild(i), cb);
    }
}

function text(node, src) {
    return src.slice(node.startIndex, node.endIndex);
}

function classifyImport(importName, classIndex) {
    // Java standard library
    if (isJavaStdLib(importName)) {
        return { type: "external", values: [importName] };
    }

    // Wildcard import
    if (importName.endsWith(".*")) {
        const prefix = importName.replace(".*", "");

        const matched = Object.entries(classIndex)
            .filter(([fqcn]) => fqcn.startsWith(prefix + "."))
            .map(([_, file]) => file);

        if (matched.length > 0) {
            return { type: "local", values: matched };
        }

        return { type: "external", values: [importName] };
    }

    // Exact class import
    if (classIndex[importName]) {
        return {
            type: "local",
            values: [classIndex[importName]]
        };
    }

    // Unresolved → external dependency
    return { type: "external", values: [importName] };
}

function isJavaStdLib(name) {
    return (
        name.startsWith("java.") ||
        name.startsWith("javax.") ||
        name.startsWith("jakarta.")
    );
}
// Build a map of class names to their file paths from imports
function buildImportMap(imports) {
    const map = {};

    for (const file of imports.importFiles) {
        // Extract class name from file path
        const className = path.basename(file, '.java');
        map[className] = file;
    }

    return map;
}
// Resolve method call path using import map
function resolveCallPath(callName, importMap, externalImports) {
    // Check if it's a known imported class method
    for (const [className, filePath] of Object.entries(importMap)) {
        if (callName.startsWith(className + ".") || importMap[callName]) {
            return filePath;
        }
    }

    // Check if it matches any external import pattern
    for (const extImport of externalImports) {
        const parts = extImport.split('.');
        const className = parts[parts.length - 1];
        if (callName === className || callName.startsWith(className + ".")) {
            return extImport;
        }
    }

    return null;
}

// ---------- extract everything from ONE parse ----------
function analyzeFile(filePath) {
    const sourceText = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
    const tree = parser.parse(sourceText);

    const imports = {
        importFiles: [],
        externalImports: []
    };

    const methods = [];
    const classes = [];

    traverse(tree.rootNode, node => {
        // ---------- imports ----------
        if (node.type === "import_declaration") {
            const name = text(node, sourceText)
                .replace("import", "")
                .replace("static", "")
                .replace(";", "")
                .trim();

            const resolved = classifyImport(name, classIndex);
            if (resolved.type === "local") {
                imports.importFiles.push(...resolved.values);
            } else {
                imports.externalImports.push(...resolved.values);
            }
        }

        // ---------- class declarations ----------
        if (node.type === "class_declaration") {
            const nameNode = node.childForFieldName("name");
            if (!nameNode) return;

            const className = text(nameNode, sourceText);

            // Find extends clause
            let extendsClass = null;
            const superclassNode = node.childForFieldName("superclass");
            if (superclassNode) {
                extendsClass = text(superclassNode, sourceText).replace("extends", "").trim();
            }

            const classInfo = {
                name: className,
                extends: extendsClass,
                constructorParams: [],
                methods: [],
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1
            };

            // Find all methods and constructors in this class
            traverse(node, n => {
                if (n.type === "method_declaration") {
                    const methodNameNode = n.childForFieldName("name");
                    if (methodNameNode) {
                        classInfo.methods.push(text(methodNameNode, sourceText));
                    }
                }

                if (n.type === "constructor_declaration") {
                    const constructorNameNode = n.childForFieldName("name");
                    if (constructorNameNode) {
                        // Extract constructor parameters
                        const paramsNode = n.childForFieldName("parameters");
                        if (paramsNode) {
                            traverse(paramsNode, paramNode => {
                                if (paramNode.type === "formal_parameter") {
                                    const typeNode = paramNode.childForFieldName("type");
                                    if (typeNode) {
                                        classInfo.constructorParams.push(text(typeNode, sourceText));
                                    }
                                }
                            });
                        }
                    }
                }
            });

            classes.push(classInfo);
        }

        // ---------- methods / constructors ----------
        if (
            node.type === "method_declaration" ||
            node.type === "constructor_declaration"
        ) {
            const nameNode = node.childForFieldName("name");
            if (!nameNode) return;

            const fn = {
                name: text(nameNode, sourceText),
                type: "method_definition",
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                path: path.relative(repoPath, filePath),
                calls: []
            };

            // ---------- method calls inside body ----------
            traverse(node, n => {
                if (n.type === "method_invocation") {
                    const callNameNode = n.childForFieldName("name");
                    if (callNameNode) {
                        fn.calls.push({
                            name: text(callNameNode, sourceText),
                            path: null // resolved later if needed
                        });
                    }
                }
            });

            methods.push(fn);
        }
    });

    imports.importFiles = [...new Set(imports.importFiles)];
    imports.externalImports = [...new Set(imports.externalImports)];

    // Build import map for resolving calls
    const importMap = buildImportMap(imports);

    // Resolve method call paths
    for (const method of methods) {
        for (const call of method.calls) {
            call.path = resolveCallPath(call.name, importMap, imports.externalImports);
        }
    }

    return {
        path: path.relative(repoPath, filePath),
        imports,
        classes,
        functions: methods
    };
}

// ---------- run ----------
const output = [];
for (const file of files) {
    try {
        output.push(analyzeFile(file));
    } catch (e) {
        // ignore broken files
    }
}

parentPort.postMessage(output);
