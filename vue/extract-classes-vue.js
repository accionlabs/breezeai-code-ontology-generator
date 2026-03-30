/**
 * Vue SFC Class Extractor
 *
 * Extracts ES6 classes from the <script> block of Vue SFCs.
 * Thin wrapper that parses source string and applies line offset.
 */

const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const { containsDbQuery, getDbFromMethod, getApiCallInfo, extractEndpointFromArgs } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(JavaScript);

const CLASS_STATEMENT_TYPES = [
  "lexical_declaration",
  "variable_declaration",
  "public_field_definition",
];

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractClassesFromSource(source, lineOffset) {
  const tree = sharedParser.parse(source);
  const classes = [];

  traverse(tree.rootNode, (node) => {
    if (node.type !== "class_declaration" && node.type !== "class") return;

    const name = getClassName(node);
    if (!name) return;

    const superClass = getSuperClassName(node);
    const { constructorParams, methodNames } = extractClassMembers(node);
    const statements = extractClassStatements(node, source, lineOffset);

    classes.push({
      name,
      type: "class",
      visibility: "public",
      isAbstract: false,
      extends: superClass,
      implements: [],
      constructorParams,
      methods: methodNames,
      statements,
      startLine: node.startPosition.row + 1 + lineOffset,
      endLine: node.endPosition.row + 1 + lineOffset,
    });
  });

  return classes;
}

function getClassName(node) {
  const id = node.childForFieldName("name");
  return id ? id.text : null;
}

function getSuperClassName(node) {
  const superNode = node.childForFieldName("superclass");
  return superNode ? superNode.text : null;
}

function extractClassMembers(classNode) {
  const body = classNode.childForFieldName("body");
  if (!body) return { constructorParams: [], methodNames: [] };

  const methodNames = [];
  let constructorParams = [];

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member.isNamed) continue;

    if (member.type === "method_definition") {
      const nameNode = member.childForFieldName("name");
      const name = nameNode ? nameNode.text : null;
      if (name === "constructor") {
        const fnNode = member.childForFieldName("value") || member;
        const paramsNode = fnNode.childForFieldName("parameters");
        if (paramsNode) {
          for (let j = 0; j < paramsNode.namedChildCount; j++) {
            constructorParams.push(paramsNode.namedChild(j).text);
          }
        }
      } else if (name) {
        methodNames.push(name);
      }
    }
  }

  return { constructorParams, methodNames };
}

function extractClassStatements(node, source, lineOffset) {
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
      startLine: child.startPosition.row + 1 + lineOffset,
      endLine: child.endPosition.row + 1 + lineOffset,
    });
  }

  return statements;
}

module.exports = { extractClassesFromSource };
