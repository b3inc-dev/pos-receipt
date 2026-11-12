import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const files = ['AGENTS.md', 'README.md', ...['PROJECT_CONTEXT', 'ARCHITECTURE', 'BUSINESS_RULES', 'DECISIONS', 'BACKLOG', 'DEVELOPMENT_TESTING', 'DEV_FIRST_THEN_DEPLOY'].map(n => `docs/${n}.md`)];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(text)) throw new Error(`Conflict marker: ${file}`);
  for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^[a-z]+:|^#/i.test(link)) continue;
    if (!existsSync(path.resolve(path.dirname(file), link.split('#')[0]))) throw new Error(`Missing link: ${file} -> ${link}`);
  }
}
console.log(`Development docs lint: ${files.length} files, local links and conflict markers passed (not application JS/TS lint).`);
