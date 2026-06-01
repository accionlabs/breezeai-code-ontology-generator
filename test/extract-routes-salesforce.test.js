/**
 * Regression test for the Salesforce Apex REST route extractor.
 * Covers @RestResource(urlMapping) + @HttpGet/@HttpPost/etc.
 * Run: node test/extract-routes-salesforce.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractFileRoutes } = require("../salesforce/extract-routes-salesforce");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function withTempFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apexroutes-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const byMethod = (routes, m) => routes.find((r) => r.method === m);

// ----------------------------------------------------------- Apex REST ----
withTempFile("CaseManager.cls", `@RestResource(urlMapping='/api/v1/cases/*')
global with sharing class CaseManager {
    @HttpGet
    global static Case getCaseById() { return null; }
    @HttpPost
    global static ID createCase(String subject) { return null; }
    @HttpPut
    global static ID upsertCase() { return null; }
    @HttpDelete
    global static void deleteCase() { }
    global static void helperNotARoute() { }
}`, (file) => {
  const r = extractFileRoutes(file);
  check("apex: 4 routes (one per Http verb)", r.length === 4);
  check("apex: framework + function-scoped", r.every((x) => x.framework === "apex" && x.scope === "function"));
  check("apex: all share the class urlMapping", r.every((x) => x.path === "/api/v1/cases/*"));
  check("apex: GET handler", byMethod(r, "GET").handler === "getCaseById");
  check("apex: POST handler", byMethod(r, "POST").handler === "createCase");
  check("apex: PUT + DELETE present", byMethod(r, "PUT") && byMethod(r, "DELETE"));
  check("apex: non-annotated method ignored", !r.some((x) => x.handler === "helperNotARoute"));
});

// ----------------------------------- @HttpGet WITHOUT @RestResource ----
withTempFile("PlainService.cls", `public class PlainService {
    @HttpGet
    public static void notRest() { }
    public Integer add(Integer a, Integer b) { return a + b; }
}`, (file) => {
  // No class-level @RestResource -> not a REST endpoint, no urlMapping.
  check("apex: @HttpGet without @RestResource -> no routes", extractFileRoutes(file).length === 0);
});

// ---------------------------------------------------------- plain class ----
withTempFile("Util.cls", `public class Util {
    public static String greet() { return 'hi'; }
}`, (file) => {
  check("apex: plain class -> no routes", extractFileRoutes(file).length === 0);
});

console.log(`\n✅ All ${passed} assertions passed.`);
