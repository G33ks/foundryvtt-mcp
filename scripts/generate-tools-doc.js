#!/usr/bin/env node

/**
 * Generates docs/tools.md from the tool definitions, so the reference never
 * drifts from what the server lists.
 *
 *   npm run build && npm run docs:tools            # write docs/tools.md
 *   npm run build && npm run docs:tools -- --check  # exit 1 if it is out of date
 *
 * Reads the built server (dist/), like the smoke tests: the tool groups of
 * src/tools/definitions.ts, whether each tool writes (write-tools.ts) and
 * what it needs (tool-dependencies.ts). Every exported group must be given a
 * section below, and every listed tool must land in exactly one: a new group
 * fails the script until it is placed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const distTools = join(repoRoot, 'dist', 'tools');
const outputPath = join(repoRoot, 'docs', 'tools.md');

/** Sections of docs/tools.md, in order, and the definition groups each holds. */
const SECTIONS = [
  {
    title: 'Actors and items',
    groups: ['actorTools', 'actorMutationTools', 'itemTools', 'itemMutationTools', 'effectTools'],
  },
  { title: 'Tokens', groups: ['tokenTools', 'tokenMutationTools'] },
  { title: 'Scenes', groups: ['sceneTools', 'sceneMutationTools'] },
  {
    title: 'Canvas',
    groups: [
      'wallMutationTools',
      'tileTools',
      'tileMutationTools',
      'placeableTools',
      'placeableMutationTools',
      'regionTools',
    ],
  },
  { title: 'Combat', groups: ['combatTools', 'combatMutationTools'] },
  { title: 'Journals', groups: ['journalTools', 'journalMutationTools'] },
  { title: 'Chat and dice', groups: ['chatTools', 'chatMutationTools', 'diceTools'] },
  {
    title: 'World',
    groups: [
      'worldTools',
      'worldDocumentTools',
      'worldDocumentMutationTools',
      'rollTableTools',
      'userTools',
      'settingsTools',
    ],
  },
  { title: 'Compendiums, rules and generators', groups: ['compendiumTools', 'generationTools'] },
  { title: 'Companion module', groups: ['moduleBridgeTools'] },
  { title: 'Events and diagnostics', groups: ['eventTools', 'diagnosticsTools'] },
];

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(2);
}

async function load(file) {
  const path = join(distTools, file);
  if (!existsSync(path)) {
    fail(`${path} not found: run \`npm run build\` first.`);
  }
  return import(pathToFileURL(path).href);
}

/** Text from a definition, safe in Markdown: `<token>` would vanish as an HTML tag. */
function text(value) {
  return String(value).replace(/</g, '&lt;');
}

function needsLabel(name, deps) {
  const dependency = deps.toolDependency(name);
  let label;
  switch (dependency) {
    case 'socket':
      label = 'FoundryVTT connection';
      break;
    case 'socket+bridge':
      label = deps.needsBridge(name, {})
        ? 'FoundryVTT connection, companion module'
        : 'FoundryVTT connection; companion module for some arguments';
      break;
    case 'bridge':
      label = 'Companion module';
      break;
    case 'rest':
      label = 'REST API module';
      break;
    case 'rest-or-local':
      label = 'REST API module when a key is set, otherwise none';
      break;
    case 'local':
    case 'health':
      label = 'None';
      break;
    default:
      fail(`${name} is not classified in src/tools/tool-dependencies.ts.`);
  }
  return deps.prefersBridge(name) ? `${label}; companion module when connected` : label;
}

function typeLabel(schema) {
  if (!schema || typeof schema !== 'object') {
    return 'any';
  }
  if (Array.isArray(schema.enum)) {
    return `one of ${schema.enum.map((value) => `\`${JSON.stringify(value)}\``).join(', ')}`;
  }
  if (schema.type === 'array') {
    return schema.items?.type ? `array of ${schema.items.type}` : 'array';
  }
  return schema.type ?? 'any';
}

function renderParameters(schema) {
  const properties = schema?.properties ?? {};
  const names = Object.keys(properties);
  if (names.length === 0) {
    return ['No parameters.'];
  }
  const required = new Set(schema.required ?? []);
  const lines = ['Parameters:', ''];
  for (const name of names) {
    const property = properties[name];
    const flags = [typeLabel(property), required.has(name) ? 'required' : 'optional'].join(', ');
    const description = property.description ? ` — ${text(property.description)}` : '';
    lines.push(`- \`${name}\` (${flags})${description}`);
  }
  if (Array.isArray(schema.oneOf)) {
    const choices = schema.oneOf.map((option) => (option.required ?? []).map((n) => `\`${n}\``).join(' + '));
    lines.push('', `Exactly one of: ${choices.join(', ')}.`);
  }
  return lines;
}

async function render() {
  const definitions = await load('definitions.js');
  const writes = await load('write-tools.js');
  const deps = await load('tool-dependencies.js');

  const listed = definitions.getAllTools();
  const exportedGroups = Object.entries(definitions).filter(([, value]) => Array.isArray(value));
  const placed = new Set(SECTIONS.flatMap((section) => section.groups));
  for (const [name] of exportedGroups) {
    if (!placed.has(name)) {
      fail(`The tool group ${name} has no section in scripts/generate-tools-doc.js.`);
    }
  }
  const groups = new Map(exportedGroups);
  const seen = new Map();
  const sections = SECTIONS.map((section) => {
    const tools = section.groups.flatMap((group) => {
      if (!groups.has(group)) {
        fail(`scripts/generate-tools-doc.js names ${group}, which src/tools/definitions.ts does not export.`);
      }
      return groups.get(group);
    });
    for (const tool of tools) {
      seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1);
    }
    return { title: section.title, tools };
  });
  for (const tool of listed) {
    if (seen.get(tool.name) !== 1) {
      fail(`${tool.name} appears ${seen.get(tool.name) ?? 0} times in docs/tools.md, not once.`);
    }
  }
  if (seen.size !== listed.length) {
    fail('docs/tools.md would list tools the server does not.');
  }

  const writeCount = listed.filter((tool) => writes.isWriteTool(tool.name)).length;
  const out = [
    '# Tools',
    '',
    '<!-- Generated by scripts/generate-tools-doc.js from src/tools/definitions.ts. Do not edit by hand: run `npm run build && npm run docs:tools`. -->',
    '',
    `The connector offers ${listed.length} tools: ${listed.length - writeCount} that read and ${writeCount} that change the world. Each description below is the one your AI client receives.`,
    '',
    '- **Access**: *Write* tools change the world. They are refused unless `FOUNDRY_WRITE_ENABLED=true`, and run one at a time, in the order they arrive.',
    '- **Needs**: what the tool uses. *FoundryVTT connection*: the Socket.IO connection, always there. *Companion module*: the module running in the invisible GM session (`FOUNDRY_MODULE_BRIDGE_ENABLED=true`). *REST API module*: the separate module enabled by `FOUNDRY_API_KEY`. See [Configuration](configuration.md).',
    '',
    '| Group | Tools | Write |',
    '| :--- | ---: | ---: |',
  ];
  for (const section of sections) {
    const anchor = section.title.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
    const sectionWrites = section.tools.filter((tool) => writes.isWriteTool(tool.name)).length;
    out.push(`| [${section.title}](#${anchor}) | ${section.tools.length} | ${sectionWrites} |`);
  }

  for (const section of sections) {
    out.push('', `## ${section.title}`, '', '| Tool | Access | Needs |', '| :--- | :--- | :--- |');
    for (const tool of section.tools) {
      const access = writes.isWriteTool(tool.name) ? 'Write' : 'Read';
      out.push(`| [\`${tool.name}\`](#${tool.name}) | ${access} | ${needsLabel(tool.name, deps)} |`);
    }
    for (const tool of section.tools) {
      out.push('', `### \`${tool.name}\``, '', text(tool.description), '', ...renderParameters(tool.inputSchema));
    }
  }
  return `${out.join('\n')}\n`;
}

const content = await render();
if (process.argv.includes('--check')) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  if (current !== content) {
    console.error('❌ docs/tools.md is out of date: run `npm run build && npm run docs:tools` and commit it.');
    process.exit(1);
  }
  console.log('✅ docs/tools.md matches the tool definitions.');
} else {
  writeFileSync(outputPath, content);
  console.log(`✅ Wrote ${outputPath}`);
}
