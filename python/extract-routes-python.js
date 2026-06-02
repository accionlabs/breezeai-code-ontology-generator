/**
 * Python web-route extractor (static, tree-sitter based)
 *
 * Detects HTTP route / endpoint declarations for the three most common
 * Python web frameworks and returns them as structured route objects:
 *
 *   Django   - urls.py: path(), re_path(), url(), include(); CBV `.as_view()`;
 *              dotted-path string views; DRF `router.register()`.
 *   Flask    - `@app.route(...)`, method shortcuts `@app.get/post/...`,
 *              blueprint decorators, and `app.add_url_rule(...)`.
 *   FastAPI  - `@app.get/post/...`, `@router.api_route(...)`, `@app.websocket(...)`,
 *              `app.include_router(...)`, and Starlette-style `app.mount(...)`.
 *
 * The framework is inferred from import statements for the cases where the
 * decorator shape is ambiguous (e.g. `@app.get("/x")` is valid in both Flask
 * 2.x and FastAPI); framework-unique call names (path/re_path/include_router/…)
 * are classified directly by name.
 *
 * Mirrors the `api_call` statement convention in extract-functions-nodejs.js:
 * each route is also surfaced as a `{ type: "route", ... }` statement so it
 * flows through the existing HAS_STATEMENT ingestion pipeline.
 */
const Parser = require("tree-sitter");
const Python = require("tree-sitter-python");
const path = require("path");
const { parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(Python);

// Decorator attribute names that map directly to an HTTP method.
const METHOD_DECORATORS = new Set([
  "get", "post", "put", "delete", "patch", "head", "options", "trace",
]);

// Django URLConf call names (framework-unique).
const DJANGO_URL_CALLS = new Set(["path", "re_path", "url"]);

const MAX_TEXT = 500;

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function slice(source, node, limit = MAX_TEXT) {
  if (!node) return null;
  return source.slice(node.startIndex, node.endIndex).slice(0, limit);
}

/**
 * Extract the literal value of a Python string node, handling raw (r""),
 * f-string (f""), byte, and triple-quoted prefixes. Returns null for
 * non-string nodes (e.g. a variable used as the route).
 */
function getStringValue(node, source) {
  if (!node || node.type !== "string") return null;

  let prefix = "";
  let content = "";
  let sawContent = false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.type === "string_start") prefix = source.slice(c.startIndex, c.endIndex);
    else if (c.type === "string_content") {
      content += source.slice(c.startIndex, c.endIndex);
      sawContent = true;
    }
  }

  if (!sawContent) {
    // Grammar didn't split the literal — strip prefix + quotes by hand.
    const raw = source.slice(node.startIndex, node.endIndex);
    const m = raw.match(/^([a-zA-Z]*)('''|"""|'|")([\s\S]*)\2$/);
    if (!m) return null;
    prefix = m[1];
    content = m[3];
  }

  const isRaw = /r/i.test(prefix);
  const isF = /f/i.test(prefix);
  let value = content;
  if (isF) value = value.replace(/\{[^}]*\}/g, "{param}"); // collapse interpolations
  return { value, isRaw, isF };
}

function getCallFunction(callNode) {
  return callNode && callNode.type === "call"
    ? callNode.childForFieldName("function")
    : null;
}

// Root identifier of an attribute chain: a.b.c -> "a"
function rootObjectName(attrNode, source) {
  let cur = attrNode;
  while (cur && cur.type === "attribute") cur = cur.childForFieldName("object");
  return cur && cur.type === "identifier" ? slice(source, cur) : null;
}

function attributeName(attrNode, source) {
  const attr = attrNode && attrNode.childForFieldName("attribute");
  return attr ? slice(source, attr) : null;
}

// Positional (non-keyword) argument nodes of a call's argument_list.
function positionalArgs(argList) {
  const out = [];
  if (!argList) return out;
  for (let i = 0; i < argList.namedChildCount; i++) {
    const c = argList.namedChild(i);
    if (
      c.type === "keyword_argument" ||
      c.type === "dictionary_splat" ||
      c.type === "list_splat"
    ) continue;
    out.push(c);
  }
  return out;
}

/**
 * Collect import module names to infer the active framework where the
 * route syntax alone is ambiguous.
 */
function detectFrameworks(rootNode, source) {
  let flask = false, fastapi = false, django = false;
  traverse(rootNode, (n) => {
    if (n.type === "import_statement" || n.type === "import_from_statement") {
      const text = source.slice(n.startIndex, n.endIndex).toLowerCase();
      if (text.includes("flask")) flask = true;
      if (text.includes("fastapi") || text.includes("starlette")) fastapi = true;
      if (text.includes("django") || text.includes("rest_framework")) django = true;
    }
  });
  return { flask, fastapi, django };
}

function lineInfo(node) {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

/**
 * Describe a Django view argument (2nd arg of path/re_path/url).
 * Resolves CBV `.as_view()`, nested `include(...)`, dotted-path strings,
 * and plain references.
 */
function describeDjangoView(node, source) {
  if (!node) return { handler: null, kind: "route", cbv: false };

  if (node.type === "call") {
    const fn = getCallFunction(node);
    // include("app.urls")  /  include((patterns, "app_name"))
    if (fn && fn.type === "identifier" && slice(source, fn) === "include") {
      const args = positionalArgs(node.childForFieldName("arguments"));
      const target = args[0] ? (getStringValue(args[0], source)?.value || slice(source, args[0])) : null;
      return { handler: target, kind: "include", cbv: false };
    }
    // SomeView.as_view()  -> class-based view
    if (fn && fn.type === "attribute" && attributeName(fn, source) === "as_view") {
      const obj = fn.childForFieldName("object");
      return { handler: (slice(source, obj) || "") + ".as_view()", kind: "route", cbv: true };
    }
    return { handler: slice(source, node, 120), kind: "route", cbv: false };
  }

  // dotted-path string view: "myapp.views.home"
  const str = getStringValue(node, source);
  if (str) return { handler: str.value, kind: "route", cbv: false, dotted: true };

  // views.home / home
  return { handler: slice(source, node, 120), kind: "route", cbv: false };
}

function makeRoute(fields) {
  // Normalize and build both the structured record and its `text` summary.
  const method = fields.method || "ANY";
  const routePath = fields.path != null ? fields.path : "";
  const arrow = fields.handler ? ` -> ${fields.handler}` : "";
  const text = `[${fields.framework}] ${method} ${routePath}${arrow}`;
  return {
    type: "route",
    framework: fields.framework,
    method,
    path: routePath,
    handler: fields.handler || null,
    kind: fields.kind || "route",
    isRegex: !!fields.isRegex,
    decorator: fields.decorator || null,
    // `scope` tells the mapper where to hang the route: "function" routes
    // (Flask/FastAPI decorators) attach to their handler Function node;
    // "file" routes (Django urls.py, mounts, includes) attach to the File.
    scope: fields.scope || "file",
    handlerLine: fields.handlerLine != null ? fields.handlerLine : null,
    text: (fields.text || text).slice(0, MAX_TEXT),
    startLine: fields.startLine,
    endLine: fields.endLine,
  };
}

/**
 * Main entry: returns an array of route objects for a single Python file.
 */
function extractRoutes(filePath, source, tree) {
  const root = tree.rootNode;
  const fw = detectFrameworks(root, source);
  const routes = [];

  // Closure-bound keyword-arg helper (needs `source`).
  const kw = (argList, name) => {
    if (!argList) return null;
    for (let i = 0; i < argList.namedChildCount; i++) {
      const c = argList.namedChild(i);
      if (c.type !== "keyword_argument") continue;
      const key = c.childForFieldName("name");
      if (key && slice(source, key) === name) return c.childForFieldName("value");
    }
    return null;
  };

  // Framework guess for ambiguous decorator shapes (@app.get / @app.post).
  const ambiguousFramework = () =>
    fw.fastapi ? "fastapi" : fw.flask ? "flask" : "unknown";

  // Collect HTTP methods from a `methods=[...]` kwarg, else fall back.
  const methodsFromKwarg = (argList, fallback) => {
    const val = kw(argList, "methods");
    if (val && val.type === "list") {
      const out = [];
      for (let i = 0; i < val.namedChildCount; i++) {
        const s = getStringValue(val.namedChild(i), source);
        if (s) out.push(s.value.toUpperCase());
      }
      if (out.length) return out.join(",");
    }
    return fallback;
  };

  // -------------------------------------------------------------------
  // 1) Decorator-based routes (Flask / FastAPI): @obj.method("/path", ...)
  // -------------------------------------------------------------------
  traverse(root, (node) => {
    if (node.type !== "decorated_definition") return;
    const def = node.childForFieldName("definition");
    const handlerName = def && def.childForFieldName("name")
      ? slice(source, def.childForFieldName("name"))
      : null;
    // Line of the `def`/`async def` so the mapper can match the exact
    // handler Function node (name + startLine) without ambiguity.
    const handlerLine = def ? def.startPosition.row + 1 : null;

    for (let i = 0; i < node.childCount; i++) {
      const dec = node.child(i);
      if (dec.type !== "decorator") continue;

      // The decorator expression: a `call` for @app.route("/x")
      let callNode = null;
      for (let j = 0; j < dec.childCount; j++) {
        if (dec.child(j).type === "call") { callNode = dec.child(j); break; }
      }
      if (!callNode) continue;

      const fn = getCallFunction(callNode);
      if (!fn || fn.type !== "attribute") continue;
      const attr = attributeName(fn, source);
      const obj = rootObjectName(fn, source);
      const argList = callNode.childForFieldName("arguments");
      const pos = positionalArgs(argList);
      const pathStr = pos[0] ? getStringValue(pos[0], source) : null;
      const li = lineInfo(callNode);

      let framework = null;
      let method = null;

      if (attr === "route") {
        // Flask classic: @app.route("/x", methods=["POST"])
        framework = fw.flask ? "flask" : ambiguousFramework();
        method = methodsFromKwarg(argList, "GET");
      } else if (METHOD_DECORATORS.has(attr)) {
        framework = ambiguousFramework();
        method = attr.toUpperCase();
      } else if (attr === "websocket") {
        framework = "fastapi";
        method = "WEBSOCKET";
      } else if (attr === "api_route") {
        framework = "fastapi";
        method = methodsFromKwarg(argList, "ANY");
      } else {
        continue; // not a routing decorator
      }

      routes.push(makeRoute({
        framework,
        method,
        path: pathStr ? pathStr.value : null,
        handler: handlerName,
        kind: "route",
        decorator: `${obj}.${attr}`,
        scope: "function",
        handlerLine,
        text: slice(source, callNode),
        ...li,
      }));
    }
  });

  // -------------------------------------------------------------------
  // 2) Call-based routes (Django URLConf, DRF, add_url_rule, mounts)
  // -------------------------------------------------------------------
  // Track include() calls nested inside path() so we don't double-report.
  const nestedIncludeRanges = [];

  traverse(root, (node) => {
    if (node.type !== "call") return;
    const fn = getCallFunction(node);
    if (!fn) return;

    const argList = node.childForFieldName("arguments");
    const pos = positionalArgs(argList);
    const li = lineInfo(node);

    // --- Django: path() / re_path() / url() ---
    if (fn.type === "identifier" && DJANGO_URL_CALLS.has(slice(source, fn))) {
      const callName = slice(source, fn);
      const isRegex = callName === "re_path" || callName === "url";
      const routeStr = pos[0] ? getStringValue(pos[0], source) : null;
      const view = describeDjangoView(pos[1], source);

      if (view.kind === "include" && pos[1] && pos[1].type === "call") {
        nestedIncludeRanges.push({ start: pos[1].startIndex, end: pos[1].endIndex });
      }

      routes.push(makeRoute({
        framework: "django",
        method: "ANY",
        path: routeStr ? routeStr.value : null,
        handler: view.handler,
        kind: view.kind,
        isRegex,
        decorator: null,
        text: slice(source, node),
        ...li,
      }));
      return;
    }

    if (fn.type === "identifier" && slice(source, fn) === "include") {
      // Standalone include() not wrapped by path() — record once.
      const isNested = nestedIncludeRanges.some(
        (r) => node.startIndex >= r.start && node.endIndex <= r.end
      );
      if (isNested) return;
      const target = pos[0]
        ? (getStringValue(pos[0], source)?.value || slice(source, pos[0]))
        : null;
      routes.push(makeRoute({
        framework: "django",
        method: "ANY",
        path: null,
        handler: target,
        kind: "include",
        text: slice(source, node),
        ...li,
      }));
      return;
    }

    if (fn.type !== "attribute") return;
    const attr = attributeName(fn, source);
    const obj = rootObjectName(fn, source);

    // --- DRF: router.register("prefix", ViewSet, basename=...) ---
    if (attr === "register") {
      if (!pos.length) return;
      const prefix = getStringValue(pos[0], source);
      routes.push(makeRoute({
        framework: "django",
        method: "ANY",
        path: prefix ? prefix.value : slice(source, pos[0], 120),
        handler: pos[1] ? slice(source, pos[1], 120) : null,
        kind: "viewset",
        decorator: `${obj}.register`,
        text: slice(source, node),
        ...li,
      }));
      return;
    }

    // --- Flask: app.add_url_rule("/x", view_func=..., methods=[...]) ---
    if (attr === "add_url_rule") {
      const routeStr = pos[0] ? getStringValue(pos[0], source) : null;
      const viewFunc = kw(argList, "view_func");
      routes.push(makeRoute({
        framework: fw.flask ? "flask" : ambiguousFramework(),
        method: methodsFromKwarg(argList, "GET"),
        path: routeStr ? routeStr.value : null,
        handler: viewFunc ? slice(source, viewFunc, 120) : null,
        kind: "add_url_rule",
        decorator: `${obj}.add_url_rule`,
        text: slice(source, node),
        ...li,
      }));
      return;
    }

    // --- FastAPI: app.include_router(router, prefix="/x") ---
    if (attr === "include_router") {
      const prefix = kw(argList, "prefix");
      const prefixStr = prefix ? getStringValue(prefix, source) : null;
      routes.push(makeRoute({
        framework: "fastapi",
        method: "ANY",
        path: prefixStr ? prefixStr.value : "",
        handler: pos[0] ? slice(source, pos[0], 120) : null,
        kind: "include",
        decorator: `${obj}.include_router`,
        text: slice(source, node),
        ...li,
      }));
      return;
    }

    // --- Starlette/FastAPI: app.mount("/x", app2) ---
    if (attr === "mount") {
      const routeStr = pos[0] ? getStringValue(pos[0], source) : null;
      routes.push(makeRoute({
        framework: fw.fastapi ? "fastapi" : ambiguousFramework(),
        method: "ANY",
        path: routeStr ? routeStr.value : null,
        handler: pos[1] ? slice(source, pos[1], 120) : null,
        kind: "mount",
        decorator: `${obj}.mount`,
        text: slice(source, node),
        ...li,
      }));
      return;
    }
  });

  // Stable ordering by source position.
  routes.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return routes;
}

/**
 * File-level helper used by the python file-tree mapper.
 * Returns route objects ready to be merged into a file's `statements`.
 */
function extractFileRoutes(filePath) {
  try {
    const { source, tree } = parseSource(filePath, sharedParser);
    return extractRoutes(filePath, source, tree);
  } catch (e) {
    return [];
  }
}

module.exports = { extractRoutes, extractFileRoutes };

// -------------------------------------------------------------
// CLI mode: node python/extract-routes-python.js <file.py>
// -------------------------------------------------------------
if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node python/extract-routes-python.js <file.py>");
    process.exit(1);
  }
  const routes = extractFileRoutes(path.resolve(target));
  console.log(JSON.stringify(routes, null, 2));
  console.log(`\n${routes.length} route(s) detected.`);
}
