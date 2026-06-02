/**
 * Go web-route extractor (static, tree-sitter based).
 *
 * All Go routing is call-based (no decorators), so routes are file-scoped:
 *   Gin         r.GET/POST/...("/path", h), r.Any, r.Handle("GET", "/path", h), r.Group("/v1")
 *   chi         r.Get/Post/...("/path", h), r.Method("GET", "/path", h), r.Route/Mount
 *   gorilla/mux r.HandleFunc("/path", h).Methods("GET","POST"), r.Handle(...), r.PathPrefix(...)
 *   net/http    http.HandleFunc("/path", h); Go 1.22+ "GET /path" method-in-pattern
 *
 * Framework is inferred from imports + call shape (Gin uses ALL-CAPS verbs,
 * chi uses TitleCase). Detection is gated on a web-framework import and a
 * route-like path to avoid false positives (e.g. cache.Get("key")).
 *
 * Emitted as `type:"route"` statements, reusing the shared graph fields.
 */
const Parser = require("tree-sitter");
const Go = require("tree-sitter-go");
const path = require("path");
const { parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(Go);

const MAX_TEXT = 500;

// Gin: ALL-CAPS verb methods. chi: TitleCase verb methods.
const GIN_VERBS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const CHI_VERBS = new Set(["Get", "Post", "Put", "Delete", "Patch", "Head", "Options", "Connect", "Trace"]);
const HTTP_METHOD_NAMES = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT", "TRACE"]);
const HANDLE_METHODS = new Set(["Handle", "HandleFunc", "Method", "MethodFunc"]);
const GROUP_METHODS = { Group: "gin", Route: "chi", Mount: "chi", PathPrefix: "gorilla" };

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) traverse(node.child(i), cb);
}

function text(source, node, limit = MAX_TEXT) {
  return node ? source.slice(node.startIndex, node.endIndex).slice(0, limit) : null;
}

function getString(source, node) {
  if (!node) return null;
  if (node.type === "interpreted_string_literal") {
    let out = "";
    let had = false;
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i).type === "interpreted_string_literal_content") { out += text(source, node.child(i)); had = true; }
    }
    return had ? out : text(source, node).replace(/^"|"$/g, "");
  }
  if (node.type === "raw_string_literal") {
    return text(source, node).replace(/^`|`$/g, "");
  }
  return null;
}

function pathLike(p) {
  return typeof p === "string" && p.startsWith("/");
}

function handlerText(source, node) {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "selector_expression" || node.type === "call_expression") {
    return text(source, node, 80);
  }
  return null; // func_literal (inline) etc.
}

// Gin/chi handlers are variadic: (path, ...middleware, handler) — the real
// handler is the LAST argument, not the first one after the path.
function lastHandler(source, pos) {
  return pos.length ? handlerText(source, pos[pos.length - 1]) : null;
}

function detectImports(root, source) {
  const mods = new Set();
  traverse(root, (n) => {
    if (n.type === "import_spec" || n.type === "import_declaration") {
      for (let i = 0; i < n.childCount; i++) {
        const s = getString(source, n.child(i));
        if (s) mods.add(s);
      }
    }
  });
  const has = (re) => [...mods].some((m) => re.test(m));
  return {
    gin: has(/gin-gonic\/gin/),
    chi: has(/go-chi\/chi/),
    gorilla: has(/gorilla\/mux/),
    nethttp: has(/^net\/http$/),
    any: has(/gin-gonic\/gin|go-chi\/chi|gorilla\/mux|^net\/http$/),
  };
}

function makeRoute(f) {
  const method = f.method || "ANY";
  const endpoint = f.path != null ? f.path : "";
  const arrow = f.handler ? ` -> ${f.handler}` : "";
  return {
    type: "route",
    framework: f.framework,
    method,
    path: endpoint,
    handler: f.handler || null,
    kind: f.kind || "route",
    isRegex: false,
    decorator: f.decorator || null,
    scope: "file",
    handlerLine: null,
    text: (f.text || `[${f.framework}] ${method} ${endpoint}${arrow}`).slice(0, MAX_TEXT),
    startLine: f.startLine,
    endLine: f.endLine,
  };
}

// selector_expression -> { obj root identifier, property }
function selectorParts(source, sel) {
  const prop = sel.childForFieldName("field");
  const property = prop ? text(source, prop) : null;
  let cur = sel.childForFieldName("operand");
  while (cur && (cur.type === "selector_expression" || cur.type === "call_expression")) {
    cur = cur.type === "call_expression"
      ? cur.childForFieldName("function")
      : cur.childForFieldName("operand");
  }
  const objRoot = cur ? text(source, cur, 40) : null;
  return { objRoot, property };
}

function positionalArgs(callNode) {
  const args = callNode.childForFieldName("arguments");
  const out = [];
  if (!args) return out;
  for (let i = 0; i < args.namedChildCount; i++) out.push(args.namedChild(i));
  return out;
}

// gorilla: HandleFunc(...).Methods("GET","POST") -> ["GET","POST"] or null.
function chainedMethods(source, callNode) {
  const parent = callNode.parent;
  if (!parent || parent.type !== "selector_expression") return null;
  const field = parent.childForFieldName("field");
  if (!field || text(source, field) !== "Methods") return null;
  const outer = parent.parent;
  if (!outer || outer.type !== "call_expression") return null;
  const methods = [];
  for (const a of positionalArgs(outer)) {
    const s = getString(source, a);
    if (s) methods.push(s.toUpperCase());
  }
  return methods.length ? methods : null;
}

function extractRoutes(filePath, source, tree) {
  const root = tree.rootNode;
  const fw = detectImports(root, source);
  const routes = [];
  if (!fw.any) return routes; // require a web-framework import

  traverse(root, (node) => {
    if (node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");
    if (!fn || fn.type !== "selector_expression") return;
    const { objRoot, property } = selectorParts(source, fn);
    if (!property) return;
    const pos = positionalArgs(node);
    const li = { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
    const snippet = text(source, node);

    // 1) Gin ALL-CAPS verbs + Any
    if (GIN_VERBS.has(property) || property === "Any") {
      const p = getString(source, pos[0]);
      if (!pathLike(p) || !pos[1]) return;
      routes.push(makeRoute({
        framework: "gin", method: property === "Any" ? "ANY" : property, path: p,
        handler: lastHandler(source, pos), decorator: `${objRoot}.${property}`,
        text: snippet, ...li,
      }));
      return;
    }

    // 2) chi TitleCase verbs
    if (CHI_VERBS.has(property)) {
      const p = getString(source, pos[0]);
      if (!pathLike(p) || !pos[1]) return;
      routes.push(makeRoute({
        framework: "chi", method: property.toUpperCase(), path: p,
        handler: lastHandler(source, pos), decorator: `${objRoot}.${property}`,
        text: snippet, ...li,
      }));
      return;
    }

    // 3) Handle / HandleFunc / Method / MethodFunc
    if (HANDLE_METHODS.has(property)) {
      const a0 = getString(source, pos[0]);
      // method-first form: Handle("GET", "/p", h) (gin) / Method("GET", "/p", h) (chi)
      if (a0 && HTTP_METHOD_NAMES.has(a0.toUpperCase()) && pathLike(getString(source, pos[1]))) {
        routes.push(makeRoute({
          framework: objRoot === "http" ? "nethttp" : (fw.chi ? "chi" : fw.gin ? "gin" : "go"),
          method: a0.toUpperCase(), path: getString(source, pos[1]),
          handler: lastHandler(source, pos), decorator: `${objRoot}.${property}`,
          text: snippet, ...li,
        }));
        return;
      }
      // path-first form
      let method = "ANY";
      let p = a0;
      const m = /^([A-Z]+)\s+(\/\S*)$/.exec(a0 || ""); // Go 1.22 "GET /path"
      if (m) { method = m[1]; p = m[2]; }
      const chained = chainedMethods(source, node);
      if (chained) method = chained.join(",");
      if (!pathLike(p)) return;
      const framework = objRoot === "http" ? "nethttp"
        : chained ? "gorilla"
        : fw.gorilla ? "gorilla" : fw.nethttp ? "nethttp" : fw.gin ? "gin" : fw.chi ? "chi" : "go";
      routes.push(makeRoute({
        framework, method, path: p,
        handler: lastHandler(source, pos), decorator: `${objRoot}.${property}`,
        text: snippet, ...li,
      }));
      return;
    }

    // 4) Route groups / subrouters / mounts (prefix scopes, best-effort)
    if (GROUP_METHODS[property]) {
      const p = getString(source, pos[0]);
      if (!pathLike(p)) return;
      routes.push(makeRoute({
        framework: fw.gin ? "gin" : fw.chi ? "chi" : fw.gorilla ? "gorilla" : GROUP_METHODS[property],
        method: "ANY", path: p, kind: "mount",
        handler: pos[1] ? handlerText(source, pos[1]) : null,
        decorator: `${objRoot}.${property}`, text: snippet, ...li,
      }));
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
    console.error("Usage: node golang/extract-routes-golang.js <file.go>");
    process.exit(1);
  }
  const routes = extractFileRoutes(path.resolve(target));
  console.log(JSON.stringify(routes, null, 2));
  console.log(`\n${routes.length} route(s) detected.`);
}
