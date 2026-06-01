/**
 * Regression test for the Python web-route extractor.
 * Run: node test/extract-routes-python.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractFileRoutes } = require("../python/extract-routes-python");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function withTempFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const find = (routes, pathStr) => routes.find((r) => r.path === pathStr);

// ---------------------------------------------------------------- Django ----
withTempFile("urls.py", `
from django.urls import path, re_path, include
from django.conf.urls import url
from . import views
from .views import ArticleView

urlpatterns = [
    path("home/", views.home, name="home"),
    path("about/", AboutView.as_view(), name="about"),
    re_path(r"^articles/(?P<id>[0-9]+)/$", ArticleView.as_view()),
    url(r"^legacy/$", "myapp.views.legacy_handler"),
    path("api/", include("api.urls")),
]
`, (file) => {
  const r = extractFileRoutes(file);
  check("django: 5 routes", r.length === 5);
  check("django: all framework=django", r.every((x) => x.framework === "django"));
  check("django: path() FBV view", find(r, "home/").handler === "views.home");
  check("django: CBV as_view() resolved", find(r, "about/").handler === "AboutView.as_view()");
  check("django: re_path marked regex", find(r, "^articles/(?P<id>[0-9]+)/$").isRegex === true);
  check("django: url() dotted-path string view",
    find(r, "^legacy/$").handler === "myapp.views.legacy_handler");
  check("django: include() kind", find(r, "api/").kind === "include");
  check("django: include() target", find(r, "api/").handler === "api.urls");
  check("django: routes are file-scoped", r.every((x) => x.scope === "file"));
});

// ----------------------------------------------------------------- Flask ----
withTempFile("flask_app.py", `
from flask import Flask, Blueprint
app = Flask(__name__)
bp = Blueprint("bp", __name__)

@app.route("/users", methods=["GET", "POST"])
def users():
    return "ok"

@app.get("/health")
def health():
    return "ok"

@bp.post("/login")
def login():
    return "ok"

app.add_url_rule("/legacy", view_func=legacy_view, methods=["PUT"])
`, (file) => {
  const r = extractFileRoutes(file);
  check("flask: 4 routes", r.length === 4);
  check("flask: all framework=flask", r.every((x) => x.framework === "flask"));
  check("flask: route methods kwarg", find(r, "/users").method === "GET,POST");
  check("flask: route handler", find(r, "/users").handler === "users");
  check("flask: method shortcut get", find(r, "/health").method === "GET");
  check("flask: blueprint post", find(r, "/login").method === "POST");
  check("flask: add_url_rule", find(r, "/legacy").kind === "add_url_rule");
  check("flask: decorator routes are function-scoped",
    find(r, "/users").scope === "function" && find(r, "/health").scope === "function");
  check("flask: handlerLine points at def line", find(r, "/users").handlerLine === 7);
  check("flask: add_url_rule stays file-scoped", find(r, "/legacy").scope === "file");
});

// --------------------------------------------------------------- FastAPI ----
withTempFile("fastapi_app.py", `
from fastapi import FastAPI, APIRouter
app = FastAPI()
router = APIRouter()

@app.get("/items/{item_id}")
async def read_item(item_id: int):
    return {}

@router.post("/orders")
async def create_order():
    return {}

@app.websocket("/ws")
async def ws_endpoint():
    return {}

app.include_router(router, prefix="/v1")
`, (file) => {
  const r = extractFileRoutes(file);
  check("fastapi: 4 routes", r.length === 4);
  check("fastapi: all framework=fastapi", r.every((x) => x.framework === "fastapi"));
  check("fastapi: path param preserved", find(r, "/items/{item_id}").method === "GET");
  check("fastapi: router handler name", find(r, "/orders").handler === "create_order");
  check("fastapi: websocket method", find(r, "/ws").method === "WEBSOCKET");
  check("fastapi: include_router prefix", find(r, "/v1").kind === "include");
});

// --------------------------------------------------------- non-web file -----
withTempFile("plain.py", `
def add(a, b):
    return a + b

class Foo:
    def bar(self):
        return 1
`, (file) => {
  const r = extractFileRoutes(file);
  check("plain module: no routes", r.length === 0);
});

console.log(`\n✅ All ${passed} assertions passed.`);
