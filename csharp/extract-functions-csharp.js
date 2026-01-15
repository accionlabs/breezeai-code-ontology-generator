const Parser = require("tree-sitter");
const CSharp = require("tree-sitter-c-sharp");
const fs = require("fs");
const path = require("path");

function extractFunctionsWithCalls(filePath, repoPath = null) {
  const source = fs.readFileSync(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(CSharp);

  const tree = parser.parse(source);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "method_declaration" ||
      node.type === "constructor_declaration" ||
      node.type === "local_function_statement"
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

  const { visibility, kind, isAsync, isVirtual, isOverride } = getFunctionModifiers(node, source);

  return {
    name,
    type: getFunctionType(node),
    visibility,
    kind,
    isAsync,
    isVirtual,
    isOverride,
    params,
    startLine,
    endLine,
    calls
  };
}

function getFunctionType(node) {
  switch (node.type) {
    case "constructor_declaration":
      return "constructor";
    case "local_function_statement":
      return "local_function";
    default:
      return "method";
  }
}

function getFunctionModifiers(node, source) {
  let visibility = "private"; // C# default for methods
  let kind = "instance";
  let isAsync = false;
  let isVirtual = false;
  let isOverride = false;

  // Look through all children for modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const modText = source.slice(child.startIndex, child.endIndex);

    if (modText === "public") {
      visibility = "public";
    } else if (modText === "private") {
      visibility = "private";
    } else if (modText === "protected") {
      visibility = "protected";
    } else if (modText === "internal") {
      visibility = "internal";
    } else if (modText === "static") {
      kind = "static";
    } else if (modText === "async") {
      isAsync = true;
    } else if (modText === "virtual") {
      isVirtual = true;
    } else if (modText === "override") {
      isOverride = true;
    } else if (modText === "abstract") {
      kind = "abstract";
    }
  }

  return { visibility, kind, isAsync, isVirtual, isOverride };
}

function extractFunctionParams(node, source) {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) return [];

  const params = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);

    if (!child.isNamed) continue;

    if (child.type === "parameter") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        // Check for params keyword (varargs)
        let isParams = false;
        for (let j = 0; j < child.childCount; j++) {
          if (source.slice(child.child(j).startIndex, child.child(j).endIndex) === "params") {
            isParams = true;
            break;
          }
        }

        const paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        params.push(isParams ? "..." + paramName : paramName);
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
    if (node.type === "invocation_expression") {
      const callInfo = extractCallInfo(node, source);
      if (callInfo) {
        calls.push(callInfo);
      }
    }
  });

  return calls;
}

function extractCallInfo(node, source) {
  // Get the function/method being called
  const functionNode = node.child(0);
  if (!functionNode) return null;

  // Simple identifier call: foo()
  if (functionNode.type === "identifier") {
    return {
      name: source.slice(functionNode.startIndex, functionNode.endIndex),
      objectName: null,
      objectType: null,
      path: null
    };
  }

  // Member access call: obj.Method()
  if (functionNode.type === "member_access_expression") {
    const nameNode = functionNode.childForFieldName("name");
    let objectNode = functionNode.childForFieldName("expression");

    // Get the immediate object name before unwrapping
    const immediateObjectName = objectNode ? source.slice(objectNode.startIndex, objectNode.endIndex) : null;

    // Unwrap chained calls to get the root object
    while (objectNode && objectNode.type === "invocation_expression") {
      objectNode = objectNode.child(0);
    }

    while (objectNode && objectNode.type === "member_access_expression") {
      const innerObj = objectNode.childForFieldName("expression");
      if (!innerObj) break;
      objectNode = innerObj;
    }

    const rootObjectName = objectNode ? source.slice(objectNode.startIndex, objectNode.endIndex) : null;

    return {
      name: nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null,
      objectName: rootObjectName,
      immediateObject: immediateObjectName,
      path: null
    };
  }

  // Generic name call: Method<T>()
  if (functionNode.type === "generic_name") {
    const nameNode = functionNode.childForFieldName("name");
    return {
      name: nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null,
      objectName: null,
      path: null
    };
  }

  return null;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

// Extract using directives (imports) from a file
function extractImports(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(CSharp);
  const tree = parser.parse(source);

  const imports = {
    importFiles: [],
    externalImports: []
  };

  traverse(tree.rootNode, (node) => {
    if (node.type === "using_directive") {
      // Get the namespace being imported
      let namespace = "";

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "qualified_name" || child.type === "identifier") {
          namespace = source.slice(child.startIndex, child.endIndex);
          break;
        }
      }

      if (namespace) {
        // Check if it's a system namespace or external
        if (isCSharpStdLib(namespace)) {
          imports.externalImports.push(namespace);
        } else {
          // Could be local or external, mark as external for now
          // The mapper will resolve local vs external
          imports.externalImports.push(namespace);
        }
      }
    }
  });

  imports.externalImports = [...new Set(imports.externalImports)];

  return imports;
}

function isCSharpStdLib(namespace) {
  return (
    namespace.startsWith("System") ||
    namespace.startsWith("Microsoft") ||
    namespace.startsWith("Windows") ||
    namespace.startsWith("Newtonsoft") ||
    namespace.startsWith("NUnit") ||
    namespace.startsWith("Xunit")
  );
}

/**
 * Resolve call path using comprehensive index
 * @param {Object} call - The call object with name, objectName
 * @param {Object} index - { classIndex, fqcnIndex, methodIndex, varTypes }
 * @param {string} currentFilePath - Relative path of current file
 * @returns {string|null} - Resolved file path or null
 */
function resolveCallPath(call, index, currentFilePath) {
  const { classIndex, fqcnIndex, methodIndex, varTypes } = index;

  // If we have an object name, try to resolve its type
  if (call.objectName) {
    // Check if objectName is a known variable with a type
    const objectType = varTypes[call.objectName];

    if (objectType) {
      // Look up the type in classIndex
      if (classIndex[objectType] && classIndex[objectType].length > 0) {
        // Find the file that has this method
        if (methodIndex[call.name]) {
          const methodEntry = methodIndex[call.name].find(m => m.className === objectType);
          if (methodEntry) {
            return methodEntry.filePath;
          }
          // If exact class match not found, return the first file for this type
          return classIndex[objectType][0];
        }
        return classIndex[objectType][0];
      }
    }

    // Try to resolve objectName as a class name (static method call)
    if (classIndex[call.objectName] && classIndex[call.objectName].length > 0) {
      if (methodIndex[call.name]) {
        const methodEntry = methodIndex[call.name].find(m => m.className === call.objectName);
        if (methodEntry) {
          return methodEntry.filePath;
        }
      }
      return classIndex[call.objectName][0];
    }
  }

  // Try to resolve by method name alone
  if (call.name && methodIndex[call.name]) {
    const methodEntries = methodIndex[call.name];

    // If there's only one match, use it
    if (methodEntries.length === 1) {
      return methodEntries[0].filePath;
    }

    // If multiple matches, try to find one that's not the current file
    const otherFileEntry = methodEntries.find(m => m.filePath !== currentFilePath);
    if (otherFileEntry) {
      return otherFileEntry.filePath;
    }

    // Return the first match as fallback
    return methodEntries[0].filePath;
  }

  return null;
}

function extractFunctionsAndCalls(filePath, repoPath, index = {}) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath);
    const currentFilePath = path.relative(repoPath, filePath);

    // Ensure index has required properties
    const { classIndex = {}, fqcnIndex = {}, methodIndex = {}, varTypes = {} } = index;

    // Build local function map
    const localFunctionMap = new Map();
    functions.forEach(func => {
      localFunctionMap.set(func.name, currentFilePath);
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        // First check if it's a local function call
        if (localFunctionMap.has(call.name) && !call.objectName) {
          call.path = currentFilePath;
        } else {
          // Try to resolve using the comprehensive index
          const resolvedPath = resolveCallPath(call, { classIndex, fqcnIndex, methodIndex, varTypes }, currentFilePath);
          if (resolvedPath) {
            call.path = resolvedPath;
          }
        }

        // Clean up temporary fields
        delete call.objectName;
        delete call.immediateObject;
        delete call.objectType;
      });
    });

    return functions;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    return [];
  }
}

module.exports = { extractFunctionsAndCalls, extractImports };
