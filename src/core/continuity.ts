import type { ProjectScope } from './client';

const IDENTITY = /^[a-z0-9][a-z0-9._-]*$/;

export function validPortableIdentity(value: string): boolean {
  return IDENTITY.test(value);
}

export function suggestPortableIdentity(value: string): string {
  return slug(value);
}

export function continuityBranch(scope: ProjectScope): string {
  return `ai-memory-sync/${slug(scope.workspace)}/${slug(scope.project)}`;
}

export function hasPortableConfig(text: string, scope: ProjectScope): boolean {
  return rootValue(text, 'workspace') === scope.workspace &&
    rootValue(text, 'project') === scope.project &&
    sectionValue(text, 'briefing', 'inject_on_session_start') === 'true' &&
    sectionValue(text, 'vscode_continuity', 'git_branch') === continuityBranch(scope);
}

export function applyPortableConfig(text: string, scope: ProjectScope): string {
  let next = normalize(text);
  next = upsertRoot(next, 'workspace', quote(scope.workspace));
  next = upsertRoot(next, 'project', quote(scope.project));
  next = upsertSection(next, 'briefing', 'inject_on_session_start', 'true');
  if (sectionValue(next, 'briefing', 'max_chars') === undefined) {
    next = upsertSection(next, 'briefing', 'max_chars', '6000');
  }
  next = upsertSection(
    next,
    'vscode_continuity',
    'git_branch',
    quote(continuityBranch(scope)),
  );
  return `${next.trimEnd()}\n`;
}

function upsertRoot(text: string, key: string, value: string): string {
  const lines = text.split('\n');
  const boundary = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = boundary < 0 ? lines.length : boundary;
  const index = lines.slice(0, end).findIndex((line) => keyPattern(key).test(line));
  if (index >= 0) lines[index] = `${key} = ${value}`;
  else lines.splice(end, 0, `${key} = ${value}`, ...(end > 0 && lines[end - 1]?.trim() ? [''] : []));
  return lines.join('\n');
}

function upsertSection(text: string, section: string, key: string, value: string): string {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (header < 0) {
    if (lines.at(-1)?.trim()) lines.push('');
    lines.push(`[${section}]`, `${key} = ${value}`);
    return lines.join('\n');
  }
  let end = lines.findIndex((line, index) => index > header && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  const relative = lines.slice(header + 1, end).findIndex((line) => keyPattern(key).test(line));
  if (relative >= 0) lines[header + 1 + relative] = `${key} = ${value}`;
  else lines.splice(end, 0, `${key} = ${value}`);
  return lines.join('\n');
}

function rootValue(text: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const boundary = lines.findIndex((line) => /^\s*\[/.test(line));
  return valueInLines(boundary < 0 ? lines : lines.slice(0, boundary), key);
}

function sectionValue(text: string, section: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (header < 0) return undefined;
  let end = lines.findIndex((line, index) => index > header && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  return valueInLines(lines.slice(header + 1, end), key);
}

function valueInLines(lines: string[], key: string): string | undefined {
  const line = lines.find((candidate) => keyPattern(key).test(candidate));
  const raw = line?.split('=', 2)[1]?.trim();
  if (!raw) return undefined;
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

function keyPattern(key: string): RegExp {
  return new RegExp(`^\\s*${key}\\s*=`);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function slug(value: string): string {
  const result = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return result || 'project';
}
