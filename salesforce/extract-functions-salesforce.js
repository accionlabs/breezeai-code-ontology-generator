const Parser = require("tree-sitter");
const Apex = require("tree-sitter-sfapex");
const fs = require("fs");
const path = require("path");
const { truncateSourceCode, parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(Apex.apex);

const STATEMENT_TYPES = ["lexical_declaration", "variable_declaration", "public_field_definition", "if_statement", "for_statement", "enhanced_for_statement", "switch_statement", "return_statement", "enum_declaration"];

function extractFunctionsWithCalls(filePath, repoPath = null, captureSourceCode = false, captureStatements = false) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "method_declaration" ||
      node.type === "constructor_declaration"
    ) {
      const funcInfo = extractFunctionInfo(node, filePath, repoPath, source, captureSourceCode, captureStatements);
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(node, filePath, repoPath = null, source, captureSourceCode = false, captureStatements = false) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node, source);
  const params = extractFunctionParams(node, source);
  const calls = extractDirectCalls(node, source);

  const { visibility, kind } = getFunctionModifiers(node, source);

  const statements = captureStatements ? extractStatements(node, source) : [];

  const result = {
    name,
    type: node.type === "constructor_declaration" ? "constructor" : "method",
    visibility,
    kind,
    params,
    startLine,
    endLine,
    calls,
    statements
  };

  if (captureSourceCode && source) {
    result.sourceCode = truncateSourceCode(source.slice(node.startIndex, node.endIndex));
  }

  return result;
}

function getFunctionModifiers(node, source) {
  let visibility = "private"; // Apex default
  let kind = "instance";

  // Look through all children for modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    // Handle modifiers
    if (child.type === "modifiers") {
      for (let j = 0; j < child.childCount; j++) {
        const modifier = child.child(j);
        const modText = source.slice(modifier.startIndex, modifier.endIndex);

        if (modText === "public") {
          visibility = "public";
        } else if (modText === "private") {
          visibility = "private";
        } else if (modText === "protected") {
          visibility = "protected";
        } else if (modText === "global") {
          visibility = "public"; // Salesforce-specific
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

    if (current.type === "identifier") {
      objectName = source.slice(current.startIndex, current.endIndex);
    } else if (current.type === "field_access") {
      // Handle static method calls like MyClass.method()
      objectName = source.slice(current.startIndex, current.endIndex);
    }
  }

  return {
    name: methodName,
    objectName: objectName,
    path: null
  };
}

function isQueryStatement(node) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    const nameNode = declarator.childForFieldName("name");
    if (nameNode) {
      const name = nameNode.text || "";
      if (/query/i.test(name)) return true;
    }
  }
  return false;
}

function isStringOrTemplateAssignment(node) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    const value = declarator.childForFieldName("value") || declarator.childForFieldName("init");
    if (!value) continue;
    const vtype = value.type;
    if (vtype === "string_literal") return true;
  }
  return false;
}

function isCallAssignment(node) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    const value = declarator.childForFieldName("value") || declarator.childForFieldName("init");
    if (!value) continue;
    const vtype = value.type;
    if (vtype === "method_invocation" || vtype === "object_creation_expression" || vtype === "anonymous_expression") return true;
  }
  return false;
}

function extractStatements(node, source) {
  const body = node.childForFieldName("body");
  if (!body) return [];

  const statements = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    if ((child.type === "lexical_declaration" || child.type === "variable_declaration") && (isCallAssignment(child) || isQueryStatement(child) || isStringOrTemplateAssignment(child))) continue;
    statements.push({
      type: child.type,
      text: source.slice(child.startIndex, child.endIndex),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }
  return statements;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractReferences(filePath) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const references = [];

  // In Apex, there are no traditional imports
  // Instead, we look for type references and fully qualified names
  traverse(tree.rootNode, (node) => {
    // Look for type references in variable declarations, method parameters, etc.
    if (node.type === "type_identifier") {
      const typeName = source.slice(node.startIndex, node.endIndex);
      // Only add if it looks like a custom class (not primitive types)
      if (!isPrimitiveType(typeName)) {
        references.push(typeName);
      }
    }
  });

  return [...new Set(references)]; // Remove duplicates
}

function isPrimitiveType(typeName) {
  const primitives = [
    'String', 'Integer', 'Long', 'Double', 'Decimal', 'Boolean',
    'Date', 'Datetime', 'Time', 'Blob', 'ID', 'Object',
    'List', 'Set', 'Map', 'void'
  ];
  return primitives.includes(typeName);
}

function resolveReference(reference, currentFilePath, repoPath, classIndex) {
  // In Salesforce, classes are typically referenced by name
  // Check if we have this class in our index
  if (classIndex[reference]) {
    return classIndex[reference];
  }

  return null; // External or standard Salesforce class
}

function extractFunctionsAndCalls(filePath, repoPath, classIndex = {}, references = null, captureSourceCode = false) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath, captureSourceCode);
    if (!references) references = extractReferences(filePath);

    const functionMap = new Map();

    // Map local functions
    functions.forEach(func => {
      functionMap.set(func.name, path.relative(repoPath, filePath));
    });

    // Map class references
    references.forEach(ref => {
      const resolvedPath = resolveReference(ref, filePath, repoPath, classIndex);
      if (resolvedPath) {
        functionMap.set(ref, resolvedPath);
      }
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

function extractFileStatements(filePath) {
  const { source, tree } = parseSource(filePath, sharedParser);
  const statements = [];
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    if ((child.type === "lexical_declaration" || child.type === "variable_declaration") && (isCallAssignment(child) || isQueryStatement(child) || isStringOrTemplateAssignment(child))) continue;
    statements.push({
      type: child.type,
      text: source.slice(child.startIndex, child.endIndex),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }
  return statements;
}

module.exports = { extractFunctionsAndCalls, extractReferences, extractFileStatements };
