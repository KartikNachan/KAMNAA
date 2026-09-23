const fs = require('fs');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(function(file) {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(walk(file));
    } else { 
      if (file.endsWith('.tsx') || file.endsWith('.ts')) results.push(file);
    }
  });
  return results;
}

const files = walk('src/ui');

files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  let original = content;

  // Backgrounds with opacity (e.g. bg-blue-900/20) -> just use surface or transparent, let's use surface
  content = content.replace(/bg-[a-z]+-[0-9]{2,3}\/[0-9]{2,3}/g, 'bg-[var(--surface)]');

  // Solid backgrounds
  content = content.replace(/bg-gray-[0-9]{2,3}/g, 'bg-[var(--surface)]');
  content = content.replace(/bg-blue-[0-9]{2,3}/g, 'bg-[var(--accent-primary)]');
  content = content.replace(/bg-indigo-[0-9]{2,3}/g, 'bg-[var(--accent-primary)]');
  content = content.replace(/bg-cyan-[0-9]{2,3}/g, 'bg-[var(--accent-soft)]');
  content = content.replace(/bg-teal-[0-9]{2,3}/g, 'bg-[var(--success)]');
  content = content.replace(/bg-green-[0-9]{2,3}/g, 'bg-[var(--success)]');
  content = content.replace(/bg-red-[0-9]{2,3}/g, 'bg-[var(--error)]');
  content = content.replace(/bg-yellow-[0-9]{2,3}/g, 'bg-[var(--surface)]');
  content = content.replace(/bg-orange-[0-9]{2,3}/g, 'bg-[var(--surface)]');

  // Text
  content = content.replace(/text-gray-[89]00/g, 'text-[var(--text-primary)]');
  content = content.replace(/text-gray-[1-7]00/g, 'text-[var(--text-secondary)]');
  content = content.replace(/text-gray-50/g, 'text-[var(--text-secondary)]');
  
  content = content.replace(/text-blue-[0-9]{2,3}/g, 'text-[var(--accent-primary)]');
  content = content.replace(/text-indigo-[0-9]{2,3}/g, 'text-[var(--accent-primary)]');
  content = content.replace(/text-cyan-[0-9]{2,3}/g, 'text-[var(--accent-soft)]');
  content = content.replace(/text-teal-[0-9]{2,3}/g, 'text-[var(--success)]');
  content = content.replace(/text-green-[0-9]{2,3}/g, 'text-[var(--success)]');
  content = content.replace(/text-red-[0-9]{2,3}/g, 'text-[var(--error)]');
  content = content.replace(/text-(yellow|orange)-[0-9]{2,3}/g, 'text-[var(--accent-primary)]'); // Warning -> Accent

  // Borders
  content = content.replace(/border-gray-[0-9]{2,3}(\/[0-9]{2,3})?/g, 'border-[var(--border)]');
  content = content.replace(/border-blue-[0-9]{2,3}(\/[0-9]{2,3})?/g, 'border-[var(--accent-primary)]');
  content = content.replace(/border-indigo-[0-9]{2,3}(\/[0-9]{2,3})?/g, 'border-[var(--accent-primary)]');
  content = content.replace(/border-cyan-[0-9]{2,3}(\/[0-9]{2,3})?/g, 'border-[var(--accent-soft)]');
  content = content.replace(/border-teal-[0-9]{2,3}(\/[0-9]{2,3})?/g, 'border-[var(--success)]');
  content = content.replace(/border-green-[0-9]{2,3}(\/[0-9]{2,3})?/g, 'border-[var(--success)]');
  content = content.replace(/border-red-[0-9]{2,3}(\/[0-9]{2,3})?/g, 'border-[var(--error)]');
  content = content.replace(/border-(yellow|orange)-[0-9]{2,3}(\/[0-9]{2,3})?/g, 'border-[var(--border)]');

  // Fix white/black hardcoded if they conflict with the theme (light theme now)
  content = content.replace(/text-white/g, 'text-[var(--surface)]');
  content = content.replace(/bg-black/g, 'bg-[var(--text-primary)]');
  content = content.replace(/text-gray-300/g, 'text-[var(--text-secondary)]');
  
  if (content !== original) {
    fs.writeFileSync(f, content, 'utf8');
    console.log("Updated Tailwind colors in", f);
  }
});
