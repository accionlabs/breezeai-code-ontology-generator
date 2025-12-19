const Parser = require("tree-sitter");
const Java = require("tree-sitter-java");
const fs = require("fs");
const path = require("path");

function extractFunctionsWithCalls(filePath, repoPath = null, classIndex = {}) {
  const source = fs.readFileSync(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(Java);

  const tree = parser.parse(source);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "method_declaration" ||
      node.type === "constructor_declaration"
    ) {
      const funcInfo = extractFunctionInfo(node, filePath, repoPath, source);
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(node, filePath, repoPath = null, source) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node, source);
  const params = extractFunctionParams(node, source);
  const calls = extractDirectCalls(node, source);

  const { visibility, kind } = getFunctionModifiers(node, source);

  return {
    name,
    type: node.type === "constructor_declaration" ? "constructor" : "method",
    visibility,
    kind,
    params,  // Now returns string array
    startLine,
    endLine,
    calls
  };
}

function getFunctionModifiers(node, source) {
  let visibility = "package"; // Java default
  let kind = "instance";

  // Look through all children for modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    if (child.type === "modifiers") {
      // Iterate through modifier tokens
      for (let j = 0; j < child.childCount; j++) {
        const modifier = child.child(j);
        const modText = source.slice(modifier.startIndex, modifier.endIndex);

        if (modText === "public") {
          visibility = "public";
        } else if (modText === "private") {
          visibility = "private";
        } else if (modText === "protected") {
          visibility = "protected";
        } else if (modText === "static") {
          kind = "static";
        }
      }
    }
  }

  return { visibility, kind };
}

function extractFunctionParams(node, source) {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) return [];

  const params = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);

    if (!child.isNamed) continue;

    if (child.type === "formal_parameter") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        params.push(source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    } else if (child.type === "spread_parameter") {
      // Handle varargs
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        params.push("..." + source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    }
  }

  return params;
}

function getFunctionName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function extractDirectCalls(funcNode, source) {
  const calls = [];

  traverse(funcNode, (node) => {
    if (node.type === "method_invocation") {
      const callInfo = extractCallInfo(node, source);
      if (callInfo) {
        calls.push(callInfo);
      }
    }
  });

  return calls;
}

function extractCallInfo(node, source) {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const methodName = source.slice(nameNode.startIndex, nameNode.endIndex);

  // Try to get the object if it's a method call
  const objectNode = node.childForFieldName("object");
  let objectName = null;

  if (objectNode) {
    // Handle chained calls - get the root object
    let current = objectNode;
    while (current && current.type === "method_invocation") {
      const obj = current.childForFieldName("object");
      if (obj) {
        current = obj;
      } else {
        break;
      }
    }

    if (current && current.type === "identifier") {
      objectName = source.slice(current.startIndex, current.endIndex);
    } else if (current) {
      objectName = source.slice(current.startIndex, current.endIndex);
    }
  }

  return {
    name: methodName,
    objectName: objectName,
    path: null // Will be resolved later
  };
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

// Extract imports from a file
function extractImports(filePath, classIndex) {
  const source = fs.readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(Java);
  const tree = parser.parse(source);

  const imports = {
    importFiles: [],
    externalImports: []
  };

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_declaration") {
      const importText = source.slice(node.startIndex, node.endIndex)
        .replace("import", "")
        .replace("static", "")
        .replace(";", "")
        .trim();

      const resolved = classifyImport(importText, classIndex);
      if (resolved.type === "local") {
        imports.importFiles.push(...resolved.values);
      } else {
        imports.externalImports.push(...resolved.values);
      }
    }
  });

  imports.importFiles = [...new Set(imports.importFiles)];
  imports.externalImports = [...new Set(imports.externalImports)];

  return imports;
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

function extractFunctionsAndCalls(filePath, repoPath, classIndex) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath, classIndex);
    const imports = extractImports(filePath, classIndex);

    // Build function and class map for call resolution
    const source = fs.readFileSync(filePath, "utf8");
    const functionMap = new Map();

    // Map local functions
    functions.forEach(func => {
      functionMap.set(func.name, path.relative(repoPath, filePath));
    });

    // Map imports
    imports.importFiles.forEach(importedFile => {
      const className = path.basename(importedFile, '.java');
      functionMap.set(className, importedFile);
    });

    imports.externalImports.forEach(extImport => {
      const parts = extImport.split('.');
      const className = parts[parts.length - 1];
      functionMap.set(className, extImport);
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        // Try to resolve by method name first, then by object name
        let resolvedPath = functionMap.get(call.name);

        if (!resolvedPath && call.objectName) {
          resolvedPath = functionMap.get(call.objectName);
        }

        if (resolvedPath) {
          call.path = resolvedPath;
        }

        // Clean up temporary fields
        delete call.objectName;
      });
    });

    return functions;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    return [];
  }
}

module.exports = { extractFunctionsAndCalls, extractImports };
