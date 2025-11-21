if (process.env.npm_execpath?.includes('npx')) {
  console.log("Skipping postinstall for npx...");
  process.exit(0);
}

require('child_process').execSync('patch-package && npm rebuild tree-sitter-perl', { stdio: 'inherit' });
