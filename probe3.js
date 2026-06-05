const glob = require("glob");
const path = require("path");
const { extractFileRoutes } = require("./typescript/extract-routes-typescript");
const repo = "/home/kannan/breeze/hubexo/lmv1/backend_nodejs_tnlm";
const { getIgnorePatternsWithPrefix } = require("./ignore-patterns");
const ignore = getIgnorePatternsWithPrefix(repo, { language: "typescript" });
const ctrls = glob.sync(`${repo}/**/*.{ts,tsx}`, { ignore }).filter(f => f.includes("/src/controllers/"));

let total = 0;
const perFile = {};
for (const f of ctrls) {
  const routes = extractFileRoutes(f);
  if (routes.length) perFile[path.relative(repo, f)] = routes.length;
  total += routes.length;
}
console.log("Controllers scanned:", ctrls.length);
console.log("TOTAL LoopBack routes captured:", total);

// Verify the previously-missing controllers now emit routes
const check = [
 "src/controllers/v1/roles.controller.ts",
 "src/controllers/v1/projects.controller.ts",
 "src/controllers/v1/industrycategories.controller.ts",
 "src/controllers/v1/firms-projects.controller.ts",
 "src/controllers/tender-status.controller.ts",
 "src/controllers/v2/redis/location.controller.ts",
 "src/controllers/health-check-v2.controller.ts",
 "src/controllers/v2/user.controller.ts",
];
console.log("\nPreviously-MISSING controllers now:");
for (const c of check) {
  const r = extractFileRoutes(repo+"/"+c);
  console.log(`  ${r.length ? "OK " : "!! "} ${c}: ${r.length} routes`);
  r.slice(0,2).forEach(x=>console.log(`        ${x.method} ${x.path}  (@${x.decorator.replace('@','')})`));
}
