/**
 * VB.NET / ASP.NET web-route extractor (hybrid: tree-sitter + regex fallback).
 *
 * Detects controller attribute routing:
 *   class  <Route("api/[controller]")>            (route prefix; [controller]/[action] tokens)
 *   action <HttpGet("{id}")> / <HttpPost> / ... / <Route("alt")>
 *
 * VB.NET is rarely used with minimal APIs, so only controller actions are covered.
 *
 * Parser strategy: tree-sitter-vb-dotnet is unreliable for VB attributes (stacked
 * `<...>` lines frequently produce ERROR nodes), and the rest of the VB pipeline
 * already runs on a regex parser. So we try tree-sitter first and fall back to a
 * regex scan whenever tree-sitter is unavailable, errors, or finds nothing — which
 * keeps route detection working everywhere the VB analysis runs.
 *
 * handlerLine is the `Function`/`Sub` declaration line (NOT the attribute line),
 * matching the startLine recorded by regex-parser-vbnet so routes attach to methods.
 */
const fs = require("fs");
const path = require("path");

const MAX_TEXT = 500;
const HTTP_ATTRS = {
  HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpDelete: "DELETE",
  HttpPatch: "PATCH", HttpHead: "HEAD", HttpOptions: "OPTIONS",
};

// Optional tree-sitter (may be absent / broken in some environments).
let Parser = null, VBNet = null, tsAvailable = false;
try {
  Parser = require("tree-sitter");
  VBNet = require("tree-sitter-vb-dotnet");
  const p = new Parser();
  p.setLanguage(VBNet);
  p.parse("Public Class A\nEnd Class");
  tsAvailable = true;
} catch (e) {
  tsAvailable = false;
}

// -------------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------------
function joinPaths(base, sub) {
  base = base || "";
  sub = sub || "";
  if (!base) return sub;
  if (!sub) return base;
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const s = sub.startsWith("/") ? sub : "/" + sub;
  return b + s;
}

function controllerToken(name) {
  return name ? name.replace(/Controller$/, "") : "";
}

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
    kind: "route",
    isRegex: false,
    decorator: f.decorator || null,
    scope: "function",
    handlerLine: f.handlerLine != null ? f.handlerLine : null,
    text: (f.text || `[aspnet] ${method} ${endpoint}${arrow}`).slice(0, MAX_TEXT),
    startLine: f.startLine != null ? f.startLine : f.handlerLine,
    endLine: f.endLine != null ? f.endLine : f.handlerLine,
  };
}

// Build routes for one action from its attribute text + class context.
// `attrInfo`: { httpVerbs: [{method, template}], routeTemplate: string|null }
function buildActionRoutes(attrInfo, base, ctrlToken, handler, handlerLine, decoText) {
  const compose = (tmpl) => substituteTokens(joinPaths(base, tmpl), ctrlToken, handler);
  const routes = [];
  if (attrInfo.httpVerbs.length) {
    for (const v of attrInfo.httpVerbs) {
      const tmpl = v.template != null ? v.template : attrInfo.routeTemplate;
      routes.push(makeRoute({
        method: v.method, path: compose(tmpl), handler, handlerLine,
        decorator: `<Http${v.method[0] + v.method.slice(1).toLowerCase()}>`,
        text: decoText,
      }));
    }
  } else if (attrInfo.routeTemplate != null) {
    routes.push(makeRoute({
      method: "ANY", path: compose(attrInfo.routeTemplate), handler, handlerLine,
      decorator: "<Route>", text: decoText,
    }));
  }
  return routes;
}

// -------------------------------------------------------------------
// Regex scanner (workhorse / fallback)
// -------------------------------------------------------------------
const ATTR_LINE = /^\s*<(.+)>\s*_?\s*$/;
const CLASS_RE = /^\s*(?:(?:Public|Private|Protected|Friend|Partial|MustInherit|NotInheritable|Shared|Default)\s+)*Class\s+(\w+)/i;
const FUNC_RE = /^\s*(?:(?:Public|Private|Protected|Friend|Shared|Overrides|Overridable|Overloads|NotOverridable|MustOverride|Async|Iterator)\s+)*(?:Function|Sub)\s+(\w+)/i;

// Parse accumulated attribute text -> route info.
function parseAttrText(attrText) {
  const httpVerbs = [];
  const re = /\bHttp(Get|Post|Put|Delete|Patch|Head|Options)\b(?:\s*\(\s*"([^"]*)")?/gi;
  let m;
  while ((m = re.exec(attrText)) !== null) {
    httpVerbs.push({ method: m[1].toUpperCase(), template: m[2] != null ? m[2] : null });
  }
  const routeMatch = /\bRoute\s*\(\s*"([^"]*)"/i.exec(attrText);
  return { httpVerbs, routeTemplate: routeMatch ? routeMatch[1] : null };
}

// Class base prefix: ASP.NET MVC5/Web API uses <RoutePrefix("base")>, ASP.NET
// Core uses <Route("base")>. Recognize both.
function routePrefixFromAttrText(attrText) {
  const m = /\bRoutePrefix\s*\(\s*"([^"]*)"/i.exec(attrText)
    || /\bRoute\s*\(\s*"([^"]*)"/i.exec(attrText);
  return m ? m[1] : "";
}

function extractWithRegex(source) {
  const lines = source.split(/\r?\n/);
  const routes = [];
  let classBase = "";
  let className = "";
  let pending = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const am = line.match(ATTR_LINE);
    if (am) { pending += " " + am[1]; continue; }
    if (/^\s*$/.test(line) || /^\s*'/.test(line)) continue; // blank / comment: keep pending

    const cm = line.match(CLASS_RE);
    if (cm) {
      className = cm[1];
      classBase = routePrefixFromAttrText(pending);
      pending = "";
      continue;
    }

    const fm = line.match(FUNC_RE);
    if (fm) {
      const info = parseAttrText(pending);
      const deco = pending.trim() ? `<${pending.trim()}>` : null;
      routes.push(...buildActionRoutes(
        info, classBase, controllerToken(className), fm[1], i + 1, deco
      ));
      pending = "";
      continue;
    }

    pending = ""; // any other code line clears pending attributes
  }
  return routes;
}

// -------------------------------------------------------------------
// Tree-sitter path (used only when the parse is error-free)
// -------------------------------------------------------------------
function tsText(source, node) {
  return node ? source.slice(node.startIndex, node.endIndex) : null;
}

function tsAttrName(source, attr) {
  for (let i = 0; i < attr.childCount; i++) {
    if (attr.child(i).type === "identifier") {
      return tsText(source, attr.child(i)).split(".").pop();
    }
  }
  return null;
}

function tsAttrString(source, attr) {
  let str = null;
  (function walk(n) {
    if (str != null) return;
    if (n.type === "string_literal") { str = tsText(source, n).replace(/^"|"$/g, ""); return; }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  })(attr);
  return str;
}

function tsAttributesOf(node) {
  const out = [];
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === "attribute_block") {
      const blk = node.child(i);
      for (let j = 0; j < blk.childCount; j++) {
        if (blk.child(j).type === "attribute") out.push(blk.child(j));
      }
    }
  }
  return out;
}

// Preceding-sibling attribute_blocks (class attributes sit before class_block).
function tsPrecedingAttributes(node) {
  const out = [];
  let s = node.previousSibling;
  while (s) {
    if (s.type === "attribute_block") {
      for (let j = 0; j < s.childCount; j++) {
        if (s.child(j).type === "attribute") out.unshift(s.child(j));
      }
    } else if (s.type !== "comment") break;
    s = s.previousSibling;
  }
  return out;
}

function tsDirectIdentifier(node) {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === "identifier") return node.child(i);
  }
  return null;
}

function extractFromTree(source, tree) {
  const routes = [];
  const root = tree.rootNode;
  (function walk(node) {
    if (node.type === "class_block") {
      const nameNode = tsDirectIdentifier(node);
      const className = nameNode ? tsText(source, nameNode) : "";
      const classAttrs = [...tsAttributesOf(node), ...tsPrecedingAttributes(node)];
      let base = "";
      for (const a of classAttrs) {
        const an = tsAttrName(source, a);
        if (an === "RoutePrefix" || an === "Route") { base = tsAttrString(source, a) || ""; break; }
      }
      const ctrlToken = controllerToken(className);

      for (let i = 0; i < node.childCount; i++) {
        const m = node.child(i);
        if (m.type !== "method_declaration") continue;
        const attrs = tsAttributesOf(m);
        const httpVerbs = [];
        let routeTemplate = null;
        for (const a of attrs) {
          const name = tsAttrName(source, a);
          if (HTTP_ATTRS[name]) httpVerbs.push({ method: HTTP_ATTRS[name], template: tsAttrString(source, a) });
          else if (name === "Route") routeTemplate = tsAttrString(source, a);
        }
        const nameId = tsDirectIdentifier(m);
        const handler = nameId ? tsText(source, nameId) : null;
        const handlerLine = nameId ? nameId.startPosition.row + 1 : m.startPosition.row + 1;
        routes.push(...buildActionRoutes(
          { httpVerbs, routeTemplate }, base, ctrlToken, handler, handlerLine,
          tsText(source, m).split("\n")[0]
        ));
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  })(root);
  return routes;
}

// -------------------------------------------------------------------
// Public entry
// -------------------------------------------------------------------
function extractFileRoutes(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return [];
  }
  return extractRoutesFromSource(source);
}

function extractRoutesFromSource(source) {
  if (tsAvailable) {
    try {
      const parser = new Parser();
      parser.setLanguage(VBNet);
      const tree = parser.parse(source);
      if (!tree.rootNode.hasError) {
        const routes = extractFromTree(source, tree);
        if (routes.length) {
          routes.sort((a, b) => a.startLine - b.startLine);
          return routes;
        }
      }
    } catch (e) { /* fall through to regex */ }
  }
  const routes = extractWithRegex(source);
  routes.sort((a, b) => a.startLine - b.startLine);
  return routes;
}

module.exports = { extractFileRoutes, extractRoutesFromSource };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node vbnet/extract-routes-vbnet.js <File.vb>");
    process.exit(1);
  }
  const routes = extractFileRoutes(path.resolve(target));
  console.log(JSON.stringify(routes, null, 2));
  console.log(`\n${routes.length} route(s) detected.`);
}
