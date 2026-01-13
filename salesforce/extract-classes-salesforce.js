const Parser = require("tree-sitter");
const Apex = require("tree-sitter-sfapex");
const fs = require("fs");
const path = require("path");

function extractClasses(filePath, repoPath = null) {
  const source = fs.readFileSync(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(Apex.apex);

  const tree = parser.parse(source);

  const classes = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "class_declaration" || node.type === "interface_declaration") {
      const classInfo = extractClassInfo(node, filePath, repoPath, source);
      if (classInfo?.name) {
        classes.push(classInfo);
      }
    }
  });

  return classes;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractClassInfo(node, filePath, repoPath = null, source) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getClassName(node, source);
  const superClass = getSuperClassName(node, source);
  const interfaces = getImplementedInterfaces(node, source);
  const isInterface = node.type === "interface_declaration";

  const {
    constructorParams,
    methods,
    properties
  } = extractClassMembers(node, source);

  const { visibility, isAbstract, annotations, sharingMode } = getClassModifiers(node, source);

  return {
    name,
    type: isInterface ? "interface" : "class",
    visibility,
    isAbstract,
    annotations,
    sharingMode, // Salesforce-specific: with sharing, without sharing, inherited sharing
    extends: superClass,
    implements: interfaces,
    constructorParams,
    methods,
    properties,
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
  let visibility = "private"; // Apex default
  let isAbstract = false;
  let isVirtual = false;
  const annotations = [];
  let sharingMode = null;

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
        } else if (modText === "global") {
          visibility = "global"; // Salesforce-specific
        } else if (modText === "abstract") {
          isAbstract = true;
        } else if (modText === "virtual") {
          isVirtual = true; // Salesforce-specific
        }
      }
    }

    // Handle annotations (@isTest, @RestResource, etc.)
    if (child.type === "annotation") {
      const annoText = source.slice(child.startIndex, child.endIndex);
      annotations.push(annoText);
    }

    // Handle sharing modes (Salesforce-specific)
    const childText = source.slice(child.startIndex, child.endIndex);
    if (childText.includes("with sharing")) {
      sharingMode = "with sharing";
    } else if (childText.includes("without sharing")) {
      sharingMode = "without sharing";
    } else if (childText.includes("inherited sharing")) {
      sharingMode = "inherited sharing";
    }
  }

  return { visibility, isAbstract: isAbstract || isVirtual, annotations, sharingMode };
}

function extractClassMembers(classNode, source) {
  const body = classNode.childForFieldName("body");
  if (!body) {
    return { constructorParams: [], methods: [], properties: [] };
  }

  const methods = [];
  const properties = [];
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

    // Method
    if (member.type === "method_declaration") {
      const nameNode = member.childForFieldName("name");
      if (nameNode) {
        methods.push(source.slice(nameNode.startIndex, nameNode.endIndex));
      }
    }

    // Field/Property
    if (member.type === "field_declaration") {
      const fieldInfo = extractFieldInfo(member, source);
      if (fieldInfo) {
        properties.push(fieldInfo);
      }
    }
  }

  return { constructorParams, methods, properties };
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
    }
  }

  return params;
}

function extractFieldInfo(node, source) {
  // Get modifiers
  let visibility = "private";
  let isStatic = false;
  let isFinal = false;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

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
          visibility = "global";
        } else if (modText === "static") {
          isStatic = true;
        } else if (modText === "final") {
          isFinal = true;
        }
      }
    }
  }

  // Get declarator (variable name)
  const declaratorNode = node.childForFieldName("declarator");
  if (!declaratorNode) return null;

  const nameNode = declaratorNode.childForFieldName("name");
  if (!nameNode) return null;

  const name = source.slice(nameNode.startIndex, nameNode.endIndex);

  // Get type
  const typeNode = node.childForFieldName("type");
  const fieldType = typeNode ? source.slice(typeNode.startIndex, typeNode.endIndex) : "Object";

  // Check if has default value
  const valueNode = declaratorNode.childForFieldName("value");
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
