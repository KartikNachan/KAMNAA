const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(function(file) {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(walk(file));
    } else { 
      if (file.endsWith('.tsx') || file.endsWith('.ts') || file.endsWith('.css')) results.push(file);
    }
  });
  return results;
}

const files = walk('src/ui');

files.forEach(f => {
  let content = fs.readFileSync(f, 'utf8');
  let original = content;

  // Background/Surfaces
  content = content.replace(/var\(--color-paper\)/g, 'var(--background)');
  content = content.replace(/var\(--color-paper-2\)/g, 'var(--surface)');
  content = content.replace(/var\(--color-paper-3\)/g, 'var(--surface)');
  
  // Specific Border Overrides (to avoid border-[var(--text-primary)])
  content = content.replace(/border-\[var\(--color-ink\)]/g, 'border-[var(--border)]');
  content = content.replace(/border-\[var\(--color-ink-mute\)]/g, 'border-[var(--border)]');
  content = content.replace(/border-\[var\(--color-accent\)]/g, 'border-[var(--accent-primary)]');
  
  // Specific Background Overrides for buttons/badges
  content = content.replace(/bg-\[var\(--color-ink\)]/g, 'bg-[var(--accent-primary)]');
  content = content.replace(/bg-\[var\(--color-ink-mute\)]/g, 'bg-[var(--text-secondary)]');

  // Specific Text Overrides (when old paper was used as light text on dark buttons)
  content = content.replace(/text-\[var\(--color-paper\)]/g, 'text-[var(--surface)]');

  // Generic Variable Replacements
  content = content.replace(/var\(--color-ink\)/g, 'var(--text-primary)');
  content = content.replace(/var\(--color-ink-2\)/g, 'var(--text-secondary)');
  content = content.replace(/var\(--color-ink-mute\)/g, 'var(--text-secondary)');
  content = content.replace(/var\(--color-accent\)/g, 'var(--accent-primary)');
  content = content.replace(/var\(--color-teal\)/g, 'var(--success)');
  content = content.replace(/var\(--color-error\)/g, 'var(--error)');
  content = content.replace(/var\(--color-rule\)/g, 'var(--border)');
  content = content.replace(/var\(--color-hairline\)/g, 'var(--border)');

  if (content !== original) {
    fs.writeFileSync(f, content, 'utf8');
    console.log("Updated", f);
  }
});
