
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const fs = require("fs");
const path = require("path");
const { parseSource } = require("../utils");
const { collectQueryStatements } = require("./extract-functions-nodejs");

const sharedParser = new Parser();
sharedParser.setLanguage(JavaScript);

function extractClasses(filePath, repoPath = null, captureStatements = false) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const classes = [];

  traverse(tree.rootNode, (node) => {
      const classInfo = extractClassInfo(node, filePath, repoPath, source, captureStatements);
      // Filter out classes with null names
      if (classInfo?.name) {
        classes.push(classInfo);
      }
  });

  return classes;
}

const CLASS_STATEMENT_TYPES = ["lexical_declaration", "variable_declaration", "public_field_definition"];

function extractClassStatements(node, source) {
  const body = node.childForFieldName("body");
  if (!body) return [];

  const statements = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!CLASS_STATEMENT_TYPES.includes(child.type)) continue;
    const nameNode = child.childForFieldName("name");
    statements.push({
      type: child.type,
      name: nameNode ? nameNode.text : null,
      text: child.text,
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }

  collectQueryStatements(node, source, statements);

  return statements;
}

function traverse(node, cb, parent = null) {
  cb(node, parent);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb, node);
  }
}

/* =========================================================
   Class extraction (JavaScript – Tree-sitter)
   ========================================================= */

function extractClassInfo(node, filePath, repoPath = null, source = null, captureStatements = false) {
  if (node.type !== "class_declaration" && node.type !== "class") {
    return null;
  }

  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getClassName(node);
  const superClass = getSuperClassName(node);

  const {
    constructorParams,
    methodNames
  } = extractClassMembers(node);

//    const relativePath = repoPath ? path.relative(repoPath, filePath) : filePath;

  const statements = captureStatements ? extractClassStatements(node, source) : [];

  return {
    name,
    type: "class", // JavaScript only has classes, not interfaces
    visibility: "public", // JavaScript doesn't have visibility modifiers
    isAbstract: false, // JavaScript doesn't have abstract keyword
    extends: superClass,
    implements: [], // JavaScript doesn't have implements keyword
    constructorParams,
    methods: methodNames,
    statements,
    startLine,
    endLine
    // path: relativePath
  };
}

/* =========================================================
   Class name
   ========================================================= */

function getClassName(node) {
  // class Foo {}
  const id = node.childForFieldName("name");
  return id ? id.text : null; // anonymous allowed
}

/* =========================================================
   Superclass
   ========================================================= */

function getSuperClassName(node) {
  const superNode = node.childForFieldName("superclass");
  return superNode ? superNode.text : null;
}

/* =========================================================
   Class members
   ========================================================= */

function extractClassMembers(classNode) {
  const body = classNode.childForFieldName("body");
  if (!body) {
    return { constructorParams: [], methodNames: [] };
  }

  const methodNames = [];
  let constructorParams = [];

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member.isNamed) continue;

    // constructor() {}
    if (
      member.type === "method_definition" &&
      isConstructor(member)
    ) {
      const fnNode = member.childForFieldName("value");
      if (fnNode) {
        constructorParams = extractFunctionParams(fnNode);
      }
      continue;
    }

    // regular methods
    if (member.type === "method_definition") {
      const nameNode = member.childForFieldName("name");
      if (nameNode) {
        methodNames.push(nameNode.text);
      }
    }
  }

  return { constructorParams, methodNames };
}

/* =========================================================
   Constructor detection
   ========================================================= */

function isConstructor(methodNode) {
  const nameNode = methodNode.childForFieldName("name");
  return nameNode?.text === "constructor";
}

/* =========================================================
   Parameter extraction (same callback-safe logic)
   ========================================================= */

function extractFunctionParams(node) {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) return [];

  const params = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child.isNamed) continue;

    if (containsFunction(child)) continue;

    params.push(extractParamName(child));
  }

  return params;
}

function containsFunction(node) {
  if (
    node.type === "function_expression" ||
    node.type === "arrow_function" ||
    node.type === "function_declaration"
  ) {
    return true;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.isNamed && containsFunction(child)) {
      return true;
    }
  }

  return false;
}

function extractParamName(node) {
  switch (node.type) {
    case "identifier":
      return node.text;

    case "assignment_pattern":
      return extractParamName(node.child(0));

    case "rest_pattern":
      return "..." + extractParamName(node.child(1));

    case "object_pattern":
      return "{...}";

    case "array_pattern":
      return "[...]";

    default:
      return node.text;
  }
}

module.exports = { extractClasses }