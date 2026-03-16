const Parser = require("tree-sitter");
const VBNet = require("tree-sitter-vb-dotnet");
const fs = require("fs");
const { parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(VBNet);

function extractClasses(filePath, repoPath = null, captureStatements = false) {
  try {
    const { source, tree } = parseSource(filePath, sharedParser);

    const classes = [];

    traverse(tree.rootNode, (node) => {
      if (
        node.type === "class_block" ||
        node.type === "interface_block" ||
        node.type === "structure_block" ||
        node.type === "module_block" ||
        node.type === "enum_block"
      ) {
        const classInfo = extractClassInfo(node, filePath, repoPath, source, captureStatements);
        if (classInfo?.name) {
          classes.push(classInfo);
        }
      }
    });

    return classes;
  } catch (error) {
    console.error(`Error extracting classes from ${filePath}:`, error);
    return [];
  }
}

const CLASS_STATEMENT_TYPES = ["dim_statement", "const_declaration", "field_declaration", "enum_block", "enum_member", "attribute_block"];

function extractClassStatements(node, source) {
  const statements = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (CLASS_STATEMENT_TYPES.includes(child.type)) {
      const nameNode = child.childForFieldName("name");
      let name = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
      if (!name) {
        // Try to find identifier child
        for (let j = 0; j < child.childCount; j++) {
          const c = child.child(j);
          if (c.type === "identifier") {
            name = source.slice(c.startIndex, c.endIndex);
            break;
          }
        }
      }
      statements.push({
        type: child.type,
        name,
        text: source.slice(child.startIndex, child.endIndex),
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
      });
    }
  }
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
  const { superClass, interfaces } = getInheritanceInfo(node, source);
  const typeKind = getTypeKind(node);

  const {
    constructorParams,
    methods
  } = extractClassMembers(node, source, typeKind);

  const { visibility, isAbstract } = getClassModifiers(node, source);

  const statements = captureStatements ? extractClassStatements(node, source) : [];

  const result = {
    name,
    type: typeKind,
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

  return result;
}

function getTypeKind(node) {
  switch (node.type) {
    case "class_block":
      return "class";
    case "interface_block":
      return "interface";
    case "structure_block":
      return "structure";
    case "module_block":
      return "module";
    case "enum_block":
      return "enum";
    default:
      return "class";
  }
}

function getClassName(node, source) {
  // Try to find identifier child directly
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "identifier") {
      return source.slice(child.startIndex, child.endIndex);
    }
  }

  // Try childForFieldName
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    return source.slice(nameNode.startIndex, nameNode.endIndex);
  }

  return null;
}

function getInheritanceInfo(node, source) {
  let superClass = null;
  const interfaces = [];

  // Look for inherits_clause and implements_clause
  traverse(node, (child) => {
    // Handle Inherits clause
    if (child.type === "inherits_statement" || child.type === "inherits_clause") {
      for (let j = 0; j < child.childCount; j++) {
        const inheritChild = child.child(j);
        if (inheritChild.type === "identifier" || inheritChild.type === "qualified_name") {
          superClass = source.slice(inheritChild.startIndex, inheritChild.endIndex);
        }
      }
    }

    // Handle Implements clause
    if (child.type === "implements_statement" || child.type === "implements_clause") {
      for (let j = 0; j < child.childCount; j++) {
        const implChild = child.child(j);
        if (implChild.type === "identifier" || implChild.type === "qualified_name") {
          interfaces.push(source.slice(implChild.startIndex, implChild.endIndex));
        }
      }
    }
  });

  return { superClass, interfaces };
}

function getClassModifiers(node, source) {
  let visibility = "public"; // VB.NET classes default to Friend within assembly, but we'll use public
  let isAbstract = false;

  // Look through all children for modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const childText = source.slice(child.startIndex, child.endIndex).toLowerCase();

    // VB.NET access modifiers
    if (childText === "public") {
      visibility = "public";
    } else if (childText === "private") {
      visibility = "private";
    } else if (childText === "protected") {
      visibility = "protected";
    } else if (childText === "friend") {
      visibility = "internal";
    } else if (childText === "protected friend") {
      visibility = "protected internal";
    }

    // VB.NET class modifiers
    if (childText === "mustinherit") {
      isAbstract = true;
    }
  }

  return { visibility, isAbstract };
}

function extractClassMembers(classNode, source, typeKind) {
  const methods = [];
  let constructorParams = [];

  // Find all method declarations within this class
  traverse(classNode, (member) => {
    // Skip the class node itself
    if (member === classNode) return;

    // Skip nested classes
    if (
      member.type === "class_block" ||
      member.type === "structure_block" ||
      member.type === "module_block"
    ) {
      return;
    }

    // Methods
    if (
      member.type === "method_declaration" ||
      member.type === "constructor_declaration" ||
      member.type === "property_declaration"
    ) {
      // Make sure this method is a direct child of the class (not nested in another class)
      let parent = member.parent;
      let isDirectChild = false;
      while (parent) {
        if (parent === classNode) {
          isDirectChild = true;
          break;
        }
        if (
          parent.type === "class_block" ||
          parent.type === "structure_block" ||
          parent.type === "module_block"
        ) {
          // This is nested inside another type
          break;
        }
        parent = parent.parent;
      }

      if (!isDirectChild) return;

      const methodName = getMethodName(member, source);
      if (methodName) {
        // Handle constructor (New sub)
        if (methodName.toLowerCase() === "new" && member.type === "constructor_declaration") {
          constructorParams = extractConstructorParams(member, source);
        }
        methods.push(methodName);
      }
    }
  });

  return { constructorParams, methods };
}

function getMethodName(methodNode, source) {
  // Look for identifier
  for (let i = 0; i < methodNode.childCount; i++) {
    const child = methodNode.child(i);
    if (child.type === "identifier") {
      return source.slice(child.startIndex, child.endIndex);
    }
  }

  // Try childForFieldName
  const nameNode = methodNode.childForFieldName("name");
  if (nameNode) {
    return source.slice(nameNode.startIndex, nameNode.endIndex);
  }

  return null;
}

function extractConstructorParams(methodNode, source) {
  const params = [];

  // Look for parameter_list
  traverse(methodNode, (n) => {
    if (n.type === "parameter_list" && n.parent === methodNode) {
      for (let i = 0; i < n.childCount; i++) {
        const child = n.child(i);

        if (!child.isNamed) continue;

        if (child.type === "parameter") {
          // Get parameter name
          for (let j = 0; j < child.childCount; j++) {
            const paramChild = child.child(j);
            if (paramChild.type === "identifier") {
              params.push(source.slice(paramChild.startIndex, paramChild.endIndex));
              break;
            }
          }
        }
      }
    }
  });

  return params;
}

module.exports = { extractClasses };
