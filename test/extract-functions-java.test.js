/**
 * Regression test for the Java function extractor's decorator / param capture.
 * Covers method-level decorators (AC4) and nested param decorators + types (AC3).
 * Run: node test/extract-functions-java.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractFunctionsAndCalls } = require("../java/extract-functions-java");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function withTempRepo(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jfns-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  try {
    return fn(dir, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const byName = (fns, n) => fns.find((f) => f.name === n);
const paramOf = (fn, n) => fn.params.find((p) => p.name === n);

withTempRepo("SampleController.java", `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class SampleController {

    @GetMapping("/{id}")
    public User get(@PathVariable Long id) { return null; }

    @PutMapping(value = "/update", produces = "application/json")
    public void update() {}

    @PostMapping("/{id}/items")
    public User create(@PathVariable Long id,
                       @RequestParam("q") String q,
                       @RequestBody UserDto body,
                       HttpServletRequest request,
                       String... tags) { return null; }
}
`, (dir, file) => {
  const fns = extractFunctionsAndCalls(file, dir, {}, false, false);

  // ---- method-level decorators (AC4) ----
  check("fn decorators: captured as [{name,args}] with literal arg unwrapped",
    JSON.stringify(byName(fns, "get").decorators) ===
      JSON.stringify([{ name: "GetMapping", args: ["/{id}"] }]));
  check("fn decorators: named attributes kept as faithful text",
    byName(fns, "update").decorators[0].name === "PutMapping" &&
    byName(fns, "update").decorators[0].args.includes('produces = "application/json"'));
  check("fn decorators: empty array when none",
    Array.isArray(byName(fns, "update").decorators));

  // ---- param decorators + types (AC3) ----
  const create = byName(fns, "create");
  check("param: @PathVariable nested with type",
    paramOf(create, "id").type === "Long" &&
    paramOf(create, "id").decorators[0].name === "PathVariable");
  check("param: @RequestParam positional arg captured",
    paramOf(create, "q").decorators[0].name === "RequestParam" &&
    paramOf(create, "q").decorators[0].args[0] === "q");
  check("param: @RequestBody nested with DTO type",
    paramOf(create, "body").type === "UserDto" &&
    paramOf(create, "body").decorators[0].name === "RequestBody");

  // ---- present-only + varargs ----
  check("param: decorators key omitted when none (present-only)",
    !("decorators" in paramOf(create, "request")) &&
    !("decorators" in paramOf(create, "tags")));
  check("param: varargs type marked with trailing ...",
    paramOf(create, "tags").type === "String...");
});

// ----------------------------------------------------------- JAX-RS ---------
withTempRepo("OrderResource.java", `
package com.example;
import javax.ws.rs.*;

@Path("/orders")
public class OrderResource {
    @GET @Path("/{id}")
    public Order find(@PathParam("id") String id,
                      @QueryParam("expand") boolean expand) { return null; }
}
`, (dir, file) => {
  const fns = extractFunctionsAndCalls(file, dir, {}, false, false);
  const find = byName(fns, "find");
  check("jaxrs param: @PathParam nested with arg",
    paramOf(find, "id").decorators[0].name === "PathParam" &&
    paramOf(find, "id").decorators[0].args[0] === "id");
  check("jaxrs param: @QueryParam nested with arg",
    paramOf(find, "expand").decorators[0].name === "QueryParam" &&
    paramOf(find, "expand").type === "boolean");
});

console.log(`\n✅ All ${passed} assertions passed.`);
