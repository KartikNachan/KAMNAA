const fs = require('fs');
const path = require('path');

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.wxt', '.output', 'scratch']);
const EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.jsx', '.json', '.html', '.css', '.md', '.mdx', '.yml', '.yaml', '.svg', '.mjs', '.cjs', '.txt', '.mts', '.pending']);

let totalOccurrences = 0;
const filesToModify = [];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      // Also match if it ends with .pending
      const isPending = entry.name.endsWith('.pending');
      if (EXTENSIONS.has(ext) || isPending || entry.name === '.env' || entry.name === 'package.json') {
        const content = fs.readFileSync(fullPath, 'utf8');
        const matches = (content.match(/kamnaa/gi) || []).length;
        if (matches > 0) {
          totalOccurrences += matches;
          filesToModify.push({ path: fullPath, matches });
        }
      }
    }
  }
}

walk(process.cwd());
console.log('Total occurrences before:', totalOccurrences);
console.log('Files changed:', filesToModify.length);

if (process.argv[2] === 'replace') {
  for (const file of filesToModify) {
    let content = fs.readFileSync(file.path, 'utf8');
    content = content.replace(/KAMNAA/g, 'KAMNAA');
    content = content.replace(/Kamnaa/g, 'Kamnaa');
    content = content.replace(/kamnaa/g, 'kamnaa');
    fs.writeFileSync(file.path, content, 'utf8');
  }
  console.log('Replacement complete.');
}
