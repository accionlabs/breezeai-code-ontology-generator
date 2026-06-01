/**
 * Regression test for the Go web-route extractor.
 * Covers Gin, chi, gorilla/mux, and net/http.
 * Run: node test/extract-routes-golang.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractFileRoutes } = require("../golang/extract-routes-golang");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function withTempFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goroutes-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const find = (routes, p) => routes.find((r) => r.path === p);

// -------------------------------------------------------------------- Gin ----
withTempFile("gin.go", `package main
import "github.com/gin-gonic/gin"
func main() {
  r := gin.Default()
  r.GET("/ping", pingHandler)
  r.POST("/users", createUser)
  r.Any("/any", anyHandler)
  r.Handle("PUT", "/items/:id", updateItem)
  r.Group("/v1")
  cache.Get("not-a-route")
}`, (file) => {
  const r = extractFileRoutes(file);
  check("gin: framework", r.every((x) => x.framework === "gin"));
  check("gin: GET verb + handler", find(r, "/ping").method === "GET" && find(r, "/ping").handler === "pingHandler");
  check("gin: Any -> ANY", find(r, "/any").method === "ANY");
  check("gin: Handle method-first", find(r, "/items/:id").method === "PUT");
  check("gin: Group -> mount", find(r, "/v1").kind === "mount");
  check("gin: cache.Get('key') NOT a route", !r.some((x) => x.path === "not-a-route"));
});

// -------------------------------------------------------------------- chi ----
withTempFile("chi.go", `package main
import "github.com/go-chi/chi/v5"
func routes() {
  r := chi.NewRouter()
  r.Get("/articles", listArticles)
  r.Post("/articles", createArticle)
  r.Method("DELETE", "/articles/{id}", deleteArticle)
  r.Route("/admin", adminRoutes)
}`, (file) => {
  const r = extractFileRoutes(file);
  check("chi: framework", r.every((x) => x.framework === "chi"));
  check("chi: TitleCase verb -> method", find(r, "/articles").method === "GET");
  check("chi: Method('DELETE', ...)", find(r, "/articles/{id}").method === "DELETE");
  check("chi: Route -> mount", find(r, "/admin").kind === "mount");
});

// ------------------------------------------------------------ gorilla/mux ----
withTempFile("gorilla.go", `package main
import "github.com/gorilla/mux"
func main() {
  r := mux.NewRouter()
  r.HandleFunc("/products", getProducts).Methods("GET", "POST")
  r.HandleFunc("/products/{id}", getProduct).Methods("GET")
}`, (file) => {
  const r = extractFileRoutes(file);
  check("gorilla: framework", r.every((x) => x.framework === "gorilla"));
  check("gorilla: .Methods() chain joined", find(r, "/products").method === "GET,POST");
  check("gorilla: single Methods()", find(r, "/products/{id}").method === "GET");
});

// --------------------------------------------------------------- net/http ----
withTempFile("nethttp.go", `package main
import "net/http"
func main() {
  http.HandleFunc("/health", healthHandler)
  mux.HandleFunc("GET /items/{id}", getItem)
  http.Handle("/static", fileServer)
}`, (file) => {
  const r = extractFileRoutes(file);
  check("nethttp: framework", r.every((x) => x.framework === "nethttp"));
  check("nethttp: HandleFunc -> ANY", find(r, "/health").method === "ANY");
  check("nethttp: Go 1.22 method-in-pattern", find(r, "/items/{id}").method === "GET");
  check("nethttp: Handle", find(r, "/static") != null);
});

// --------------------------------------- variadic middleware -> handler ----
// gin/chi signature is (path, ...middleware, handler): the real handler is the
// LAST arg, not the first after the path. (Found via real-repo validation.)
withTempFile("mw.go", `package main
import "github.com/gin-gonic/gin"
func routes(r *gin.Engine) {
  r.POST("/login", CSRFMiddleware(), authApi.Login)
  r.GET("/simple", plainHandler)
}`, (file) => {
  const r = extractFileRoutes(file);
  check("gin: handler is last arg (not middleware)", find(r, "/login").handler === "authApi.Login");
  check("gin: single-handler unaffected", find(r, "/simple").handler === "plainHandler");
});

// ------------------------------------------------- false-positive guard ----
withTempFile("nodeps.go", `package main
func f() {
  r.GET("/x", h)
  cache.Get("y")
}`, (file) => {
  // no web framework import -> detection disabled
  check("no framework import: no routes", extractFileRoutes(file).length === 0);
});

console.log(`\n✅ All ${passed} assertions passed.`);
