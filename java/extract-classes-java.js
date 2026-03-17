const Parser = require("tree-sitter");
const Java = require("tree-sitter-java");
const fs = require("fs");
const path = require("path");
const { parseSource } = require("../utils");
const { collectQueryStatements } = require("./extract-functions-java");

const sharedParser = new Parser();
sharedParser.setLanguage(Java);

function extractClasses(filePath, repoPath = null, captureStatements = false) {
  const { source, tree } = parseSource(filePath, sharedParser);

  const classes = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "class_declaration" || node.type === "interface_declaration") {
      const classInfo = extractClassInfo(node, filePath, repoPath, source, captureStatements);
      if (classInfo?.name) {
        classes.push(classInfo);
      }
    }
  });

  return classes;
}

const CLASS_STATEMENT_TYPES = ["lexical_declaration", "variable_declaration", "public_field_definition", "enum_declaration"];

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
      name: nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null,
      text: source.slice(child.startIndex, child.endIndex),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }
  collectQueryStatements(node, source, statements);
  return statements;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractClassInfo(node, filePath, repoPath = null, source, captureStatements = false) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getClassName(node, source);
  const superClass = getSuperClassName(node, source);
  const interfaces = getImplementedInterfaces(node, source);
  const isInterface = node.type === "interface_declaration";

  const {
    constructorParams,
    methods
  } = extractClassMembers(node, source);

  const { visibility, isAbstract } = getClassModifiers(node, source);

  const statements = captureStatements ? extractClassStatements(node, source) : [];

  return {
    name,
    type: isInterface ? "interface" : "class",
    visibility,
    isAbstract,
    extends: superClass,
    implements: interfaces,
    constructorParams,
    methods,
    statements,
    startLine,
    endLine
  };
}

function getClassName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function getSuperClassName(node, source) {
  const superclassNode = node.childForFieldName("superclass");
  if (!superclassNode) return null;

  // The superclass node contains "extends ClassName", we need to get the type
  for (let i = 0; i < superclassNode.childCount; i++) {
    const child = superclassNode.child(i);
    if (child.type === "type_identifier") {
      return source.slice(child.startIndex, child.endIndex);
    }
  }

  return null;
}

function getImplementedInterfaces(node, source) {
  const interfacesNode = node.childForFieldName("interfaces");
  if (!interfacesNode) return [];

  const interfaces = [];

  traverse(interfacesNode, (n) => {
    if (n.type === "type_identifier") {
      interfaces.push(source.slice(n.startIndex, n.endIndex));
    }
  });

  return interfaces;
}

function getClassModifiers(node, source) {
  let visibility = "package"; // Java default
  let isAbstract = false;

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
        } else if (modText === "abstract") {
          isAbstract = true;
        }
      }
    }
  }

  return { visibility, isAbstract };
}

function extractClassMembers(classNode, source) {
  const body = classNode.childForFieldName("body");
  if (!body) {
    return { constructorParams: [], methods: [] };
  }

  const methods = [];
  let constructorParams = [];

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member.isNamed) continue;

    // Constructor
    if (member.type === "constructor_declaration") {
      const paramsNode = member.childForFieldName("parameters");
      if (paramsNode) {
        constructorParams = extractParameterNames(paramsNode, source);
      }
      continue;
    }

    // Methods - just extract names
    if (member.type === "method_declaration") {
      const nameNode = member.childForFieldName("name");
      if (nameNode) {
        methods.push(source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    }
  }

  return { constructorParams, methods };
}

function extractParameterNames(paramsNode, source) {
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

function extractFieldInfo(node, source) {
  const fields = [];

  // Get modifiers for all fields in this declaration
  let visibility = "package";
  let isStatic = false;
  let isFinal = false;

  // Look through children for modifiers
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
          isStatic = true;
        } else if (modText === "final") {
          isFinal = true;
        }
      }
    }
  }

  // Get type
  const typeNode = node.childForFieldName("type");
  const fieldType = typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : "unknown";

  // Get declarators (can have multiple: int a, b, c;)
  const declaratorNode = node.childForFieldName("declarator");
  if (declaratorNode) {
    const fieldInfo = extractDeclarator(declaratorNode, source, fieldType, visibility, isStatic, isFinal);
    if (fieldInfo) {
      fields.push(fieldInfo);
    }
  }

  // Check for additional declarators
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "variable_declarator" && child !== declaratorNode) {
      const fieldInfo = extractDeclarator(child, source, fieldType, visibility, isStatic, isFinal);
      if (fieldInfo) {
        fields.push(fieldInfo);
      }
    }
  }

  return fields;
}

function extractDeclarator(node, source, fieldType, visibility, isStatic, isFinal) {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const name = source.slice(nameNode.startIndex, nameNode.endIndex);

  // Check if it has a default value
  const valueNode = node.childForFieldName("value");
  const hasDefault = valueNode !== null;

  return {
    name,
    type: fieldType,
    visibility,
    isStatic,
    isFinal,
    hasDefault
  };
}


module.exports = { extractClasses };
