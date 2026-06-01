/**
 * Salesforce Apex REST route extractor (static, tree-sitter based).
 *
 * Apex REST has a distinctive model: ONE urlMapping per class, and each HTTP
 * verb is a separate static method — methods don't add sub-paths.
 *
 *   class  @RestResource(urlMapping='/api/v1/cases/*')
 *   method @HttpGet / @HttpPost / @HttpPut / @HttpPatch / @HttpDelete
 *            -> METHOD <class urlMapping>, attached to the handler method
 *
 * (The runtime serves these under /services/apexrest; the declared urlMapping
 * is what's emitted.)
 *
 * Emitted as `type:"route"` statements, reusing the shared graph fields.
 */
const Parser = require("tree-sitter");
const Apex = require("tree-sitter-sfapex");
const path = require("path");
const { parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(Apex.apex);

const MAX_TEXT = 500;

const HTTP_ANNOS = {
  HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpPatch: "PATCH", HttpDelete: "DELETE",
};

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) traverse(node.child(i), cb);
}

function text(source, node, limit = MAX_TEXT) {
  return node ? source.slice(node.startIndex, node.endIndex).slice(0, limit) : null;
}

function stripQuotes(s) {
  return s == null ? s : s.replace(/^['"]|['"]$/g, "");
}

// Annotation nodes live in the declaration's `modifiers` child.
function getAnnotations(declNode) {
  const out = [];
  for (let i = 0; i < declNode.childCount; i++) {
    const c = declNode.child(i);
    if (c.type !== "modifiers") continue;
    for (let j = 0; j < c.childCount; j++) {
      if (c.child(j).type === "annotation") out.push(c.child(j));
    }
  }
  return out;
}

function annotationName(source, ann) {
  for (let i = 0; i < ann.childCount; i++) {
    if (ann.child(i).type === "identifier") return text(source, ann.child(i));
  }
  return null;
}

// Value of a named annotation argument: @RestResource(urlMapping='...') -> '...'
function annotationArg(source, ann, key) {
  let argList = null;
  for (let i = 0; i < ann.childCount; i++) {
    if (ann.child(i).type === "annotation_argument_list") { argList = ann.child(i); break; }
  }
  if (!argList) return null;
  for (let i = 0; i < argList.namedChildCount; i++) {
    const kv = argList.namedChild(i);
    if (kv.type === "annotation_key_value") {
      const k = kv.child(0);
      if (k && text(source, k) === key) {
        // value is the last named child (string_literal)
        return stripQuotes(text(source, kv.namedChild(kv.namedChildCount - 1)));
      }
    } else if (kv.type === "string_literal") {
      return stripQuotes(text(source, kv)); // positional fallback
    }
  }
  return null;
}

function classUrlMapping(source, classNode) {
  for (const ann of getAnnotations(classNode)) {
    if (annotationName(source, ann) === "RestResource") {
      return annotationArg(source, ann, "urlMapping");
    }
  }
  return null; // not a REST resource
}

function methodName(source, methodNode) {
  const n = methodNode.childForFieldName("name");
  if (n) return text(source, n);
  // fallback: identifier child
  for (let i = 0; i < methodNode.childCount; i++) {
    if (methodNode.child(i).type === "identifier") return text(source, methodNode.child(i));
  }
  return null;
}

function classMethods(classNode) {
  const body = classNode.childForFieldName("body");
  const out = [];
  if (!body) return out;
  for (let i = 0; i < body.namedChildCount; i++) {
    if (body.namedChild(i).type === "method_declaration") out.push(body.namedChild(i));
  }
  return out;
}

function makeRoute(f) {
  const method = f.method || "ANY";
  const endpoint = f.path != null ? f.path : "";
  return {
    type: "route",
    framework: "apex",
    method,
    path: endpoint,
    handler: f.handler || null,
    kind: "route",
    isRegex: false,
    decorator: f.decorator || null,
    scope: "function",
    handlerLine: f.handlerLine,
    text: (f.text || `[apex] ${method} ${endpoint} -> ${f.handler}`).slice(0, MAX_TEXT),
    startLine: f.startLine,
    endLine: f.endLine,
  };
}

function extractRoutes(filePath, source, tree) {
  const routes = [];
  traverse(tree.rootNode, (node) => {
    if (node.type !== "class_declaration") return;
    const urlMapping = classUrlMapping(source, node);
    if (urlMapping == null) return; // only @RestResource classes
    for (const m of classMethods(node)) {
      for (const ann of getAnnotations(m)) {
        const name = annotationName(source, ann);
        if (!HTTP_ANNOS[name]) continue;
        const handler = methodName(source, m);
        const handlerLine = m.startPosition.row + 1;
        routes.push(makeRoute({
          method: HTTP_ANNOS[name], path: urlMapping, handler, handlerLine,
          decorator: `@${name}`, text: `@${name} ${urlMapping}`,
          startLine: ann.startPosition.row + 1, endLine: ann.endPosition.row + 1,
        }));
      }
    }
  });
  routes.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return routes;
}

function extractFileRoutes(filePath) {
  try {
    const { source, tree } = parseSource(filePath, sharedParser);
    return extractRoutes(filePath, source, tree);
  } catch (e) {
    return [];
  }
}

module.exports = { extractFileRoutes };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node salesforce/extract-routes-salesforce.js <File.cls>");
    process.exit(1);
  }
  const routes = extractFileRoutes(path.resolve(target));
  console.log(JSON.stringify(routes, null, 2));
  console.log(`\n${routes.length} route(s) detected.`);
}
