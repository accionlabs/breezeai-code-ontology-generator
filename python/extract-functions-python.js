const Parser = require("tree-sitter");
const Python = require("tree-sitter-python");
const fs = require("fs");
const path = require("path");

function extractFunctionsWithCalls(filePath, repoPath) {
  const source = fs.readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(Python);
  const tree = parser.parse(source);
  
  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "function_definition") {
      const funcInfo = extractFunctionInfo(node, filePath, repoPath, source);
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(node, filePath, repoPath, source) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node, source);
  const params = extractFunctionParams(node, source);
  const calls = extractDirectCalls(node, source);

  // Check if it's a method (inside a class)
  let visibility = "public";
  let kind = "function";
  
  if (name && name.startsWith("_") && !name.startsWith("__")) {
    visibility = "protected";
  } else if (name && name.startsWith("__") && !name.endsWith("__")) {
    visibility = "private";
  }

  // Check if inside a class
  let parent = node.parent;
  while (parent) {
    if (parent.type === "class_definition") {
      kind = "method";
      break;
    }
    parent = parent.parent;
  }

  return {
    name,
    type: node.type,
    visibility,
    kind,
    params,
    startLine,
    endLine,
    calls
  };
}

function getFunctionName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function extractFunctionParams(node, source) {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) return [];

  const params = [];
  
  traverse(paramsNode, (child) => {
    if (child.type === "identifier" && child.parent.type === "parameters") {
      const paramName = source.slice(child.startIndex, child.endIndex);
      if (paramName !== "self" && paramName !== "cls") {
        params.push(paramName);
      }
    } else if (child.type === "default_parameter") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        const paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        if (paramName !== "self" && paramName !== "cls") {
          params.push(paramName);
        }
      }
    } else if (child.type === "typed_parameter" || child.type === "typed_default_parameter") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        const paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        if (paramName !== "self" && paramName !== "cls") {
          params.push(paramName);
        }
      }
    } else if (child.type === "list_splat_pattern") {
      const nameNode = child.namedChild(0);
      if (nameNode) {
        params.push("*" + source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    } else if (child.type === "dictionary_splat_pattern") {
      const nameNode = child.namedChild(0);
      if (nameNode) {
        params.push("**" + source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    }
  });

  return params;
}

function extractDirectCalls(funcNode, source) {
  const calls = [];

  traverse(funcNode, (node) => {
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      if (!fn) return;

      if (fn.type === "identifier") {
        calls.push({
          name: source.slice(fn.startIndex, fn.endIndex),
          path: null
        });
      } else if (fn.type === "attribute") {
        const object = fn.childForFieldName("object");
        const attr = fn.childForFieldName("attribute");
        
        let objectName = null;
        if (object) {
          // Get the root object name
          let currentObj = object;
          while (currentObj.type === "attribute") {
            currentObj = currentObj.childForFieldName("object");
          }
          if (currentObj && currentObj.type === "identifier") {
            objectName = source.slice(currentObj.startIndex, currentObj.endIndex);
          }
        }
        
        calls.push({
          name: attr ? source.slice(attr.startIndex, attr.endIndex) : null,
          objectName: objectName,
          path: null
        });
      }
    }
  });

  return calls;
}

function extractImports(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(Python);
  const tree = parser.parse(source);

  const imports = [];

  traverse(tree.rootNode, (node) => {
    // import module
    if (node.type === "import_statement") {
      traverse(node, (n) => {
        if (n.type === "dotted_name" && n.parent.type === "import_statement") {
          const moduleName = source.slice(n.startIndex, n.endIndex);
          imports.push({
            source: moduleName,
            imported: []
          });
        } else if (n.type === "aliased_import") {
          const nameNode = n.childForFieldName("name");
          if (nameNode) {
            const moduleName = source.slice(nameNode.startIndex, nameNode.endIndex);
            const aliasNode = n.childForFieldName("alias");
            const alias = aliasNode ? source.slice(aliasNode.startIndex, aliasNode.endIndex) : null;
            imports.push({
              source: moduleName,
              imported: alias ? [alias] : []
            });
          }
        }
      });
    }

    // from module import name
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      let moduleName = "";
      
      if (moduleNode) {
        if (moduleNode.type === "dotted_name") {
          moduleName = source.slice(moduleNode.startIndex, moduleNode.endIndex);
        } else if (moduleNode.type === "relative_import") {
          moduleName = source.slice(moduleNode.startIndex, moduleNode.endIndex);
        }
      } else {
        // Check for relative imports without module name
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child.type === "relative_import") {
            moduleName = source.slice(child.startIndex, child.endIndex);
            break;
          }
        }
      }
      
      const importedNames = [];
      traverse(node, (n) => {
        if (n.type === "dotted_name" && n.parent.parent && n.parent.parent.type === "import_from_statement") {
          importedNames.push(source.slice(n.startIndex, n.endIndex));
        } else if (n.type === "aliased_import") {
          const nameNode = n.childForFieldName("name");
          const aliasNode = n.childForFieldName("alias");
          if (nameNode) {
            importedNames.push(
              aliasNode ? source.slice(aliasNode.startIndex, aliasNode.endIndex) : source.slice(nameNode.startIndex, nameNode.endIndex)
            );
          }
        }
      });

      if (moduleName || importedNames.length > 0) {
        imports.push({
          source: moduleName,
          imported: importedNames
        });
      }
    }
  });

  return imports;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractFunctionsAndCalls(filePath, repoPath) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath);
    const imports = extractImports(filePath);

    const functionMap = new Map();

    // Map local functions
    functions.forEach(func => {
      functionMap.set(func.name, path.relative(repoPath, filePath));
    });

    // Map imports
    imports.forEach(imp => {
      imp.imported?.forEach(imported => {
        // For Python, we'll store the module path as-is
        functionMap.set(imported, imp.source);
      });
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        let resolvedPath = functionMap.get(call.name);

        if (!resolvedPath && call.objectName) {
          resolvedPath = functionMap.get(call.objectName);
        }

        if (resolvedPath) {
          call.path = resolvedPath;
        }

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

