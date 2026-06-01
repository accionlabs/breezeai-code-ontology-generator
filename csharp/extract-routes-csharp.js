/**
 * C# / ASP.NET web-route extractor (static, tree-sitter based).
 *
 *   Controllers (attribute-based, attached to handler method):
 *     class  [Route("api/[controller]")]   (route prefix; [controller]/[action] tokens)
 *     method [HttpGet("{id}")] / [HttpPost] / ... / [Route("alt")]
 *
 *   Minimal APIs (call-based, file-scoped):
 *     app.MapGet/MapPost/MapPut/MapDelete/MapPatch("/path", handler)
 *     app.MapMethods("/path", new[]{"GET","POST"}, handler)
 *     app.MapHub<T>("/path")               -> routeKind "ws"
 *
 * Emitted as `type:"route"` statements, reusing the shared graph fields.
 */
const Parser = require("tree-sitter");
const CSharp = require("tree-sitter-c-sharp");
const path = require("path");
const { parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(CSharp);

const MAX_TEXT = 500;

const HTTP_ATTRS = {
  HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpDelete: "DELETE",
  HttpPatch: "PATCH", HttpHead: "HEAD", HttpOptions: "OPTIONS",
};
const MAP_VERBS = {
  MapGet: "GET", MapPost: "POST", MapPut: "PUT", MapDelete: "DELETE", MapPatch: "PATCH",
};

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) traverse(node.child(i), cb);
}

function text(source, node, limit = MAX_TEXT) {
  return node ? source.slice(node.startIndex, node.endIndex).slice(0, limit) : null;
}

function lastSegment(s) {
  return s ? s.split(".").pop() : s;
}

function getString(source, node) {
  if (!node) return null;
  if (node.type === "string_literal") {
    let out = "";
    let had = false;
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i).type === "string_literal_content") { out += text(source, node.child(i)); had = true; }
    }
    if (had) return out;
    return text(source, node).replace(/^@?\$?"|"$/g, "");
  }
  if (node.type === "verbatim_string_literal" || node.type === "raw_string_literal") {
    return text(source, node).replace(/^@?"+|"+$/g, "");
  }
  if (node.type === "interpolated_string_expression") {
    return text(source, node).replace(/^\$@?"|"$/g, "").replace(/\{[^}]*\}/g, "{param}");
  }
  return null;
}

function joinPaths(base, sub) {
  base = base || "";
  sub = sub || "";
  if (!base) return sub;
  if (!sub) return base;
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const s = sub.startsWith("/") ? sub : "/" + sub;
  return b + s;
}

// ASP.NET route tokens: [controller] -> class name minus "Controller", [action] -> method name.
function substituteTokens(p, controllerName, actionName) {
  if (!p) return p;
  return p
    .replace(/\[controller\]/gi, controllerName || "")
    .replace(/\[action\]/gi, actionName || "");
}

function makeRoute(f) {
  const method = f.method || "ANY";
  const endpoint = f.path != null ? f.path : "";
  const arrow = f.handler ? ` -> ${f.handler}` : "";
  return {
    type: "route",
    framework: "aspnet",
    method,
    path: endpoint,
    handler: f.handler || null,
    kind: f.kind || "route",
    isRegex: false,
    decorator: f.decorator || null,
    scope: f.scope || "file",
    handlerLine: f.handlerLine != null ? f.handlerLine : null,
    text: (f.text || `[aspnet] ${method} ${endpoint}${arrow}`).slice(0, MAX_TEXT),
    startLine: f.startLine,
    endLine: f.endLine,
  };
}

// -------------------------------------------------------------------
// Attribute helpers
// -------------------------------------------------------------------
function attributesOf(node) {
  const out = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.type !== "attribute_list") continue;
    for (let j = 0; j < c.childCount; j++) {
      if (c.child(j).type === "attribute") out.push(c.child(j));
    }
  }
  return out;
}

function attributeName(source, attr) {
  const n = attr.childForFieldName("name");
  if (n) return lastSegment(text(source, n));
  for (let i = 0; i < attr.childCount; i++) {
    const t = attr.child(i).type;
    if (t === "identifier" || t === "qualified_name" || t === "generic_name") {
      return lastSegment(text(source, attr.child(i)));
    }
  }
  return null;
}

// First positional string argument of an attribute ([HttpGet("x")] -> "x").
function attributeString(source, attr) {
  let argList = null;
  for (let i = 0; i < attr.childCount; i++) {
    if (attr.child(i).type === "attribute_argument_list") { argList = attr.child(i); break; }
  }
  if (!argList) return null;
  for (let i = 0; i < argList.namedChildCount; i++) {
    const a = argList.namedChild(i);
    if (a.type !== "attribute_argument") continue;
    const s = getString(source, a.namedChild(a.namedChildCount - 1));
    if (s != null) return s;
  }
  return null;
}

// -------------------------------------------------------------------
// Controllers
// -------------------------------------------------------------------
function className(source, classNode) {
  const n = classNode.childForFieldName("name");
  return n ? text(source, n) : null;
}

function controllerToken(name) {
  return name ? name.replace(/Controller$/, "") : "";
}

function classBaseRoute(source, classNode) {
  for (const attr of attributesOf(classNode)) {
    if (attributeName(source, attr) === "Route") return attributeString(source, attr) || "";
  }
  return "";
}

function methodRoutes(source, methodNode, base, ctrlToken) {
  const attrs = attributesOf(methodNode);
  if (!attrs.length) return [];
  const nameNode = methodNode.childForFieldName("name");
  const handler = nameNode ? text(source, nameNode) : null;
  const handlerLine = methodNode.startPosition.row + 1;

  const httpAttrs = attrs.filter((a) => HTTP_ATTRS[attributeName(source, a)]);
  const routeAttr = attrs.find((a) => attributeName(source, a) === "Route");
  const routes = [];

  const compose = (tmpl) =>
    substituteTokens(joinPaths(base, tmpl), ctrlToken, handler);
  const li = (a) => ({ startLine: a.startPosition.row + 1, endLine: a.endPosition.row + 1 });

  if (httpAttrs.length) {
    for (const a of httpAttrs) {
      const tmpl = attributeString(source, a) || (routeAttr ? attributeString(source, routeAttr) : null);
      routes.push(makeRoute({
        method: HTTP_ATTRS[attributeName(source, a)],
        path: compose(tmpl),
        handler, handlerLine, scope: "function",
        decorator: `[${attributeName(source, a)}]`, text: text(source, a), ...li(a),
      }));
    }
  } else if (routeAttr) {
    // [Route] without an HTTP verb responds to all methods.
    routes.push(makeRoute({
      method: "ANY",
      path: compose(attributeString(source, routeAttr)),
      handler, handlerLine, scope: "function",
      decorator: "[Route]", text: text(source, routeAttr), ...li(routeAttr),
    }));
  }
  return routes;
}

function extractControllerRoutes(root, source) {
  const routes = [];
  traverse(root, (node) => {
    if (node.type !== "class_declaration") return;
    const base = classBaseRoute(source, node);
    const ctrlToken = controllerToken(className(source, node));
    const body = node.childForFieldName("body");
    if (!body) return;
    for (let i = 0; i < body.namedChildCount; i++) {
      const m = body.namedChild(i);
      if (m.type === "method_declaration") {
        routes.push(...methodRoutes(source, m, base, ctrlToken));
      }
    }
  });
  return routes;
}

// -------------------------------------------------------------------
// Minimal APIs
// -------------------------------------------------------------------
function memberProperty(source, memberNode) {
  const n = memberNode.childForFieldName("name");
  if (!n) return null;
  if (n.type === "generic_name") {
    for (let i = 0; i < n.childCount; i++) {
      if (n.child(i).type === "identifier") return text(source, n.child(i));
    }
  }
  return text(source, n);
}

function argList(invocation) {
  for (let i = 0; i < invocation.childCount; i++) {
    if (invocation.child(i).type === "argument_list") return invocation.child(i);
  }
  return null;
}

function positionalArgValues(argsNode) {
  const out = [];
  if (!argsNode) return out;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const a = argsNode.namedChild(i);
    if (a.type !== "argument") continue;
    out.push(a.namedChild(a.namedChildCount - 1));
  }
  return out;
}

function arrayStrings(source, node) {
  const out = [];
  if (!node) return out;
  // new[]{...} / new string[]{...} -> initializer_expression with string children
  traverse(node, (n) => {
    if (n.type === "initializer_expression") {
      for (let i = 0; i < n.namedChildCount; i++) {
        const s = getString(source, n.namedChild(i));
        if (s != null) out.push(s);
      }
    }
  });
  return out;
}

function extractMinimalApiRoutes(root, source) {
  const routes = [];
  traverse(root, (node) => {
    if (node.type !== "invocation_expression") return;
    const fn = node.childForFieldName("function");
    if (!fn || fn.type !== "member_access_expression") return;
    const prop = memberProperty(source, fn);
    if (!prop) return;
    const args = argList(node);
    const pos = positionalArgValues(args);
    const li = { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };

    if (MAP_VERBS[prop]) {
      const p = getString(source, pos[0]);
      if (p == null) return;
      routes.push(makeRoute({
        method: MAP_VERBS[prop], path: p, kind: "route",
        decorator: prop, text: text(source, node), ...li,
      }));
      return;
    }
    if (prop === "MapMethods") {
      const p = getString(source, pos[0]);
      if (p == null) return;
      const methods = arrayStrings(source, pos[1]).map((m) => m.toUpperCase());
      routes.push(makeRoute({
        method: methods.join(",") || "ANY", path: p, kind: "route",
        decorator: "MapMethods", text: text(source, node), ...li,
      }));
      return;
    }
    if (prop === "MapHub") {
      const p = getString(source, pos[0]);
      if (p == null) return;
      routes.push(makeRoute({
        method: "WS", path: p, kind: "ws",
        decorator: "MapHub", text: text(source, node), ...li,
      }));
    }
  });
  return routes;
}

function extractRoutes(filePath, source, tree) {
  const root = tree.rootNode;
  const routes = [
    ...extractControllerRoutes(root, source),
    ...extractMinimalApiRoutes(root, source),
  ];
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
    console.error("Usage: node csharp/extract-routes-csharp.js <File.cs>");
    process.exit(1);
  }
  const routes = extractFileRoutes(path.resolve(target));
  console.log(JSON.stringify(routes, null, 2));
  console.log(`\n${routes.length} route(s) detected.`);
}
