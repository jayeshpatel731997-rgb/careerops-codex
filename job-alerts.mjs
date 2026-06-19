#!/usr/bin/env node

/**
 * job-alerts.mjs - Parse job-alert emails into Notion-ready review rows.
 *
 * Supported inputs:
 *   - A directory of .eml, .txt, .html, .json, .jsonl, or .mbox files
 *   - A single file in one of those formats
 *
 * The script does not submit applications or mutate applications.md. It reads
 * profile.yml for Jayesh's target roles, groups duplicate jobs, scores fit,
 * and writes CSV/TSV/Markdown/JSON outputs under output/job-alerts/.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'fs';
import { basename, extname, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import yaml from 'js-yaml';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = join(CAREER_OPS, 'output', 'job-alerts');
const PROFILE_PATH = join(CAREER_OPS, 'config', 'profile.yml');
const APPLICATIONS_PATH = join(CAREER_OPS, 'data', 'applications.md');
const PIPELINE_PATH = join(CAREER_OPS, 'data', 'pipeline.md');

const DEFAULT_DAYS = 7;
const DEFAULT_MIN_SCORE = 45;

const STOP_LINE_PATTERNS = [
  /unsubscribe/i,
  /manage alerts/i,
  /view all jobs/i,
  /privacy policy/i,
  /terms of service/i,
  /download the app/i,
  /job alert/i,
  /recommended jobs/i,
  /new jobs? for/i,
  /because you/i,
  /apply now/i,
  /view job/i,
  /save job/i,
];

const TITLE_WORDS = [
  'analyst', 'coordinator', 'specialist', 'planner', 'buyer', 'procurement',
  'sourcing', 'supply', 'chain', 'operations', 'logistics', 'quality',
  'manufacturing', 'industrial', 'inventory', 'materials', 'production',
  'continuous improvement', 'demand', 'scheduler', 'purchasing',
];

const EXCLUDE_TITLE_WORDS = [
  'software engineer', 'site reliability', 'developer', 'frontend', 'backend',
  'nurse', 'physician', 'sales representative', 'account executive',
  'marketing manager', 'cashier', 'driver', 'cdl', 'forklift',
  'warehouse associate', 'customer service', 'human resources', 'attorney',
];

const SENIORITY_RISK_WORDS = [
  'director', 'head of', 'vp ', 'vice president', 'principal', 'staff',
  'senior manager', 'sr. manager', 'manager,', 'manager -',
];

const SENIOR_WORDS = ['senior', 'sr.'];

const ARCHETYPES = [
  {
    name: 'Supply Chain Analyst',
    terms: [
      'supply chain', 'demand planning', 'demand planner', 'inventory',
      'replenishment', 'materials', 'material planner', 's&op', 'forecast',
      'planning analyst', 'mrp', 'erp',
    ],
  },
  {
    name: 'Procurement Analyst / Procurement Operations Coordinator',
    terms: [
      'procurement', 'purchasing', 'buyer', 'sourcing', 'supplier', 'vendor',
      'category', 'purchase order', 'po ', 'p2p', 's2p', 'contract',
    ],
  },
  {
    name: 'Operations Analyst / Operations Coordinator',
    terms: [
      'operations analyst', 'operations coordinator', 'business operations',
      'process improvement', 'sop', 'kpi', 'workflow', 'ops analyst',
    ],
  },
  {
    name: 'Industrial Engineer / Manufacturing Operations',
    terms: [
      'industrial engineer', 'manufacturing', 'production planner',
      'production', 'lean', 'continuous improvement', 'process engineer',
      'plant', 'shop floor', 'six sigma',
    ],
  },
  {
    name: 'Logistics Specialist / Global Logistics Coordinator',
    terms: [
      'logistics', 'freight', 'shipping', 'transport', 'transportation',
      'warehouse', 'distribution', 'import', 'export', 'global logistics',
    ],
  },
  {
    name: 'Quality / Continuous Improvement Analyst',
    terms: [
      'quality', 'qa', 'qc', 'continuous improvement', 'six sigma', 'dmaic',
      'compliance', 'first-pass yield', 'root cause',
    ],
  },
];

function usage() {
  console.log(`Usage:
  npm run job-alerts -- --input <file-or-directory> [options]

Options:
  --input <path>       Email export path (.eml/.mbox/.json/.jsonl/.txt/.html)
  --days <n>           Only include emails from the last n days (default: ${DEFAULT_DAYS})
  --since <YYYY-MM-DD> Include emails on or after this date
  --min-score <n>      Minimum 0-100 fit score for CSV/TSV rows (default: ${DEFAULT_MIN_SCORE})
  --include-low-fit    Keep low-fit rows in CSV/TSV too
  --top <n>            Limit CSV/TSV/Markdown rows after scoring
  --output-dir <path>  Output directory (default: output/job-alerts)
  --help              Show this help

Examples:
  npm run job-alerts -- --input data/job-alert-emails --days 3
  npm run job-alerts -- --input ~/Downloads/JobAlerts.mbox --since 2026-06-01
`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    days: DEFAULT_DAYS,
    since: null,
    minScore: DEFAULT_MIN_SCORE,
    includeLowFit: false,
    top: null,
    outputDir: DEFAULT_OUTPUT_DIR,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--input') args.input = argv[++i];
    else if (arg === '--days') args.days = parseInt(argv[++i], 10);
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--min-score') args.minScore = parseInt(argv[++i], 10);
    else if (arg === '--include-low-fit') args.includeLowFit = true;
    else if (arg === '--top') args.top = parseInt(argv[++i], 10);
    else if (arg === '--output-dir') args.outputDir = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(args.days) || args.days < 1) args.days = DEFAULT_DAYS;
  if (!Number.isFinite(args.minScore)) args.minScore = DEFAULT_MIN_SCORE;
  return args;
}

function readProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  return yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
}

function collectFiles(inputPath) {
  const resolved = inputPath.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || '~');
  if (!existsSync(resolved)) throw new Error(`Input path not found: ${resolved}`);

  const files = [];
  const walk = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path)) {
        if (child.startsWith('.')) continue;
        walk(join(path, child));
      }
    } else {
      const ext = extname(path).toLowerCase();
      if (['.eml', '.mbox', '.txt', '.html', '.json', '.jsonl'].includes(ext)) {
        files.push(path);
      }
    }
  };

  walk(resolved);
  return files.sort();
}

function parseHeaders(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const idx = normalized.search(/\n\s*\n/);
  const headerText = idx >= 0 ? normalized.slice(0, idx) : '';
  const body = idx >= 0 ? normalized.slice(idx).replace(/^\n+/, '') : normalized;
  const unfolded = headerText.replace(/\n[ \t]+/g, ' ');
  const headers = {};

  for (const line of unfolded.split('\n')) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    headers[m[1].toLowerCase()] = decodeMimeWords(m[2].trim());
  }

  return { headers, body };
}

function decodeMimeWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, enc, text) => {
    try {
      const encoding = enc.toUpperCase();
      let buf;
      if (encoding === 'B') {
        buf = Buffer.from(text, 'base64');
      } else {
        const qp = text.replace(/_/g, ' ').replace(/=([A-Fa-f0-9]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16))
        );
        buf = Buffer.from(qp, 'binary');
      }
      return buf.toString(/utf-?8/i.test(charset) ? 'utf8' : 'latin1');
    } catch {
      return text;
    }
  });
}

function parseContentType(value = '') {
  const [typePart, ...params] = value.split(';').map(s => s.trim());
  const out = { type: typePart.toLowerCase() || 'text/plain', params: {} };
  for (const param of params) {
    const m = param.match(/^([^=]+)=(?:"([^"]+)"|(.+))$/);
    if (m) out.params[m[1].toLowerCase()] = (m[2] || m[3] || '').trim();
  }
  return out;
}

function splitMultipart(body, boundary) {
  if (!boundary) return [];
  const marker = `--${boundary}`;
  const parts = [];
  let current = [];
  let inPart = false;

  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith(marker)) {
      if (inPart && current.length) parts.push(current.join('\n'));
      current = [];
      inPart = true;
      if (line.startsWith(`${marker}--`)) break;
    } else if (inPart) {
      current.push(line);
    }
  }

  return parts;
}

function decodeBody(body, transferEncoding = '') {
  const encoding = transferEncoding.toLowerCase();
  if (encoding.includes('base64')) {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }

  if (encoding.includes('quoted-printable')) {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([A-Fa-f0-9]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  return body;
}

function parseMimeEntity(raw) {
  const { headers, body } = parseHeaders(raw);
  const contentType = parseContentType(headers['content-type']);
  const transfer = headers['content-transfer-encoding'] || '';

  if (contentType.type.startsWith('multipart/')) {
    const parts = splitMultipart(body, contentType.params.boundary).map(parseMimeEntity);
    return { headers, contentType: contentType.type, parts };
  }

  return {
    headers,
    contentType: contentType.type,
    text: decodeBody(body, transfer),
    parts: [],
  };
}

function flattenMime(entity, acc = { plain: [], html: [] }) {
  if (!entity) return acc;
  if (entity.parts?.length) {
    for (const part of entity.parts) flattenMime(part, acc);
    return acc;
  }

  if (entity.contentType === 'text/html') acc.html.push(entity.text || '');
  else if (entity.contentType === 'text/plain') acc.plain.push(entity.text || '');
  return acc;
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' '));
}

function extractLinks(raw) {
  const links = new Set();
  const text = String(raw || '');
  for (const match of text.matchAll(/href=["']([^"']+)["']/gi)) links.add(cleanUrl(match[1]));
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')]+/gi)) links.add(cleanUrl(match[0]));
  return [...links].filter(Boolean);
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
    ndash: '-',
    mdash: '-',
  };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, ent) => {
    const lower = ent.toLowerCase();
    if (named[lower]) return named[lower];
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return `&${ent};`;
  });
}

function parseRawEmail(raw, sourceFile, index = 0) {
  const { headers } = parseHeaders(raw);
  const entity = parseMimeEntity(raw);
  const flat = flattenMime(entity);
  const html = flat.html.join('\n');
  const plain = flat.plain.join('\n');
  const text = normalizeText(plain || htmlToText(html || raw));
  const links = extractLinks(raw);

  return {
    id: `${basename(sourceFile)}#${index + 1}`,
    sourceFile,
    subject: headers.subject || basename(sourceFile),
    from: headers.from || '',
    date: parseDate(headers.date),
    text,
    links,
  };
}

function parseMbox(content, sourceFile) {
  const messages = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let current = [];

  for (const line of lines) {
    if (line.startsWith('From ') && current.length) {
      messages.push(current.join('\n'));
      current = [];
    } else if (!line.startsWith('From ') || current.length) {
      current.push(line);
    }
  }
  if (current.length) messages.push(current.join('\n'));

  return messages.map((raw, i) => parseRawEmail(raw, sourceFile, i));
}

function parseJsonMessages(content, sourceFile) {
  const parsed = JSON.parse(content);
  const records = Array.isArray(parsed) ? parsed : (parsed.messages || parsed.items || [parsed]);
  return records.map((record, i) => normalizeJsonMessage(record, sourceFile, i));
}

function parseJsonlMessages(content, sourceFile) {
  return content
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map((line, i) => normalizeJsonMessage(JSON.parse(line), sourceFile, i));
}

function normalizeJsonMessage(record, sourceFile, index) {
  const headers = Object.fromEntries(
    Object.entries(record.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
  );
  const subject = record.subject || headers.subject || basename(sourceFile);
  const from = record.from || record.sender || headers.from || '';
  const body = record.body || record.text || record.plain || record.snippet || '';
  const html = record.html || '';
  const text = normalizeText(body || htmlToText(html));
  const raw = `${JSON.stringify(record)}\n${body}\n${html}`;

  return {
    id: `${basename(sourceFile)}#${index + 1}`,
    sourceFile,
    subject,
    from,
    date: parseDate(record.date || record.internalDate || headers.date),
    text,
    links: extractLinks(raw),
  };
}

function readMessages(files) {
  const messages = [];
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const content = readFileSync(file, 'utf-8');
    if (ext === '.mbox') messages.push(...parseMbox(content, file));
    else if (ext === '.json') messages.push(...parseJsonMessages(content, file));
    else if (ext === '.jsonl') messages.push(...parseJsonlMessages(content, file));
    else messages.push(parseRawEmail(content, file));
  }
  return messages;
}

function parseDate(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value > 10_000_000_000 ? value : value * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeText(text) {
  return decodeHtmlEntities(String(text || ''))
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function messageWithinWindow(message, args) {
  if (!message.date) return true;
  const start = args.since
    ? new Date(`${args.since}T00:00:00`)
    : new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);
  return message.date >= start;
}

function cleanUrl(url) {
  if (!url) return '';
  try {
    const decoded = decodeHtmlEntities(url).replace(/[),.;]+$/g, '');
    const u = new URL(decoded);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|trk|ref|source|campaign|mc_)/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return decodeHtmlEntities(url).replace(/[),.;]+$/g, '');
  }
}

function compactLines(text) {
  return text
    .split('\n')
    .map(line => cleanLine(line))
    .filter(line => line.length >= 2)
    .filter(line => !STOP_LINE_PATTERNS.some(pattern => pattern.test(line)));
}

function cleanLine(line) {
  return String(line || '')
    .replace(/^[\s>*\-•·|]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeTitle(value) {
  const lower = value.toLowerCase();
  if (value.length < 4 || value.length > 110) return false;
  if (/https?:\/\//i.test(value)) return false;
  if (STOP_LINE_PATTERNS.some(pattern => pattern.test(value))) return false;
  return TITLE_WORDS.some(word => lower.includes(word));
}

function looksLikeCompany(value) {
  const lower = value.toLowerCase();
  if (!value || value.length < 2 || value.length > 70) return false;
  if (looksLikeTitle(value)) return false;
  if (/https?:\/\//i.test(value)) return false;
  if (STOP_LINE_PATTERNS.some(pattern => pattern.test(value))) return false;
  return !/(remote|hybrid|onsite|united states|chicago|full-time|contract)/i.test(lower);
}

function cleanTitle(value) {
  return cleanLine(value)
    .replace(/\b(new|promoted|actively recruiting|urgent)\b/gi, '')
    .replace(/\s*[-|]\s*(full[- ]time|contract|remote|hybrid|onsite).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCompany(value) {
  return cleanLine(value)
    .replace(/\b(is hiring|careers|jobs|job)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanLocation(value) {
  return cleanLine(value)
    .replace(/\b(full[- ]time|contract|part[- ]time|temporary)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDelimitedLine(line) {
  const parts = line.split(/\s+\|\s+|\s+-\s+|\s+--\s+/).map(cleanLine).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return null;

  const [a, b, c] = parts;
  if (looksLikeTitle(a)) {
    return { role: cleanTitle(a), company: cleanCompany(b), location: cleanLocation(c || '') };
  }
  if (looksLikeTitle(b)) {
    return { company: cleanCompany(a), role: cleanTitle(b), location: cleanLocation(c || '') };
  }
  return null;
}

function parseAtPattern(line) {
  const m = line.match(/^(.{4,110}?)\s+(?:at|@)\s+(.{2,80}?)(?:\s+[|,-]\s+(.+))?$/i);
  if (!m) return null;
  if (!looksLikeTitle(m[1])) return null;
  return {
    role: cleanTitle(m[1]),
    company: cleanCompany(m[2]),
    location: cleanLocation(m[3] || ''),
  };
}

function inferCompanyFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;

    let m = host.match(/^jobs\.lever\.co$/i) && path.match(/^\/([^/]+)/);
    if (m) return titleCaseSlug(m[1]);
    m = host.match(/job-boards(?:\.eu)?\.greenhouse\.io$/i) && path.match(/^\/([^/]+)/);
    if (m) return titleCaseSlug(m[1]);
    m = host.match(/^jobs\.ashbyhq\.com$/i) && path.match(/^\/([^/]+)/);
    if (m) return titleCaseSlug(m[1]);

    const domain = host.split('.')[0];
    if (!['linkedin', 'indeed', 'glassdoor', 'google', 'email'].includes(domain)) {
      return titleCaseSlug(domain);
    }
  } catch {
    return '';
  }
  return '';
}

function titleCaseSlug(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function lineWindow(lines, lineIndex, radius = 4) {
  const start = Math.max(0, lineIndex - radius);
  const end = Math.min(lines.length, lineIndex + radius + 1);
  return lines.slice(start, end);
}

function extractCandidates(message) {
  const lines = compactLines(message.text);
  const candidates = [];
  const structured = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parsed = parseAtPattern(line) || parseDelimitedLine(line);
    if (parsed?.role && parsed?.company) {
      structured.push({ index: i, parsed, line });
    }
  }

  for (let i = 0; i < structured.length; i++) {
    const item = structured[i];
    const nextIndex = structured[i + 1]?.index ?? lines.length;
    const evidence = lines.slice(item.index, nextIndex).join(' | ');
      candidates.push({
        ...item.parsed,
        url: '',
        evidence,
        sourceMessage: message,
      });
  }

  for (const url of message.links) {
    const linkLineIndex = findLinkLineIndex(lines, url);
    const block = findStructuredBlock(structured, lines, linkLineIndex);
    let parsed = block?.parsed || null;
    let evidence = block?.evidence || '';

    if (!parsed) {
      const window = lineWindow(lines, linkLineIndex === -1 ? 0 : linkLineIndex, 3);
      const windowText = window.join(' | ');
      const roleLine = window.find(looksLikeTitle);
      const roleIdx = roleLine ? window.indexOf(roleLine) : -1;
      const companyLine = roleIdx >= 0
        ? window.slice(roleIdx + 1).find(looksLikeCompany) || window.slice(0, roleIdx).reverse().find(looksLikeCompany)
        : '';
      parsed = {
        role: roleLine ? cleanTitle(roleLine) : inferRoleFromUrl(url),
        company: companyLine ? cleanCompany(companyLine) : inferCompanyFromUrl(url),
        location: inferLocation(windowText),
      };
      evidence = windowText;
    }

    if (parsed.role || parsed.company) {
      candidates.push({
        role: parsed.role || inferRoleFromUrl(url),
        company: parsed.company || inferCompanyFromUrl(url) || 'Unknown',
        location: parsed.location || inferLocation(evidence),
        url,
        evidence,
        sourceMessage: message,
      });
    }
  }

  return candidates
    .filter(c => c.role && c.company)
    .map(c => ({
      ...c,
      role: cleanTitle(c.role),
      company: cleanCompany(c.company),
      location: cleanLocation(c.location || ''),
      url: cleanUrl(c.url),
    }))
    .filter(c => c.role.length > 2 && c.company.length > 1);
}

function findLinkLineIndex(lines, url) {
  const target = cleanUrl(url);
  const targetPath = safeUrlPath(target);
  for (let i = 0; i < lines.length; i++) {
    const lineLinks = extractLinks(lines[i]).map(cleanUrl);
    if (lineLinks.some(link => link === target || safeUrlPath(link) === targetPath)) return i;
    if (lines[i].includes(url) || lines[i].includes(target)) return i;
  }
  return -1;
}

function safeUrlPath(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

function findStructuredBlock(structured, lines, linkLineIndex) {
  if (!structured.length || linkLineIndex < 0) return null;

  let chosen = null;
  for (let i = 0; i < structured.length; i++) {
    const item = structured[i];
    const nextIndex = structured[i + 1]?.index ?? lines.length;
    if (item.index <= linkLineIndex && linkLineIndex < nextIndex) {
      chosen = { item, nextIndex };
      break;
    }
  }

  if (!chosen) {
    const nearest = structured
      .map((item, i) => ({ item, nextIndex: structured[i + 1]?.index ?? lines.length, distance: Math.abs(item.index - linkLineIndex) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!nearest || nearest.distance > 4) return null;
    chosen = nearest;
  }

  return {
    parsed: chosen.item.parsed,
    evidence: lines.slice(chosen.item.index, chosen.nextIndex).join(' | '),
  };
}

function inferRoleFromUrl(url) {
  try {
    const u = new URL(url);
    const slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1) || '');
    const withoutId = slug.replace(/[a-f0-9-]{12,}/gi, '').replace(/\d{5,}/g, '');
    if (!withoutId || withoutId.length < 5) return '';
    return titleCaseSlug(withoutId).replace(/\bJob\b/i, '').trim();
  } catch {
    return '';
  }
}

function inferLocation(text) {
  const m = text.match(/\b(remote|hybrid|onsite|Chicago,\s*IL|United States|USA|New York,\s*NY|Dallas,\s*TX|Houston,\s*TX|Atlanta,\s*GA|Austin,\s*TX|California|Texas|Illinois)\b/i);
  return m ? m[0] : '';
}

function dedupeCandidates(candidates) {
  const map = new Map();
  for (const c of candidates) {
    const key = c.url || `${normalizeKey(c.company)}::${normalizeRole(c.role)}`;
    const existing = map.get(key);
    if (!existing || scoreCompleteness(c) > scoreCompleteness(existing)) map.set(key, c);
  }
  return [...map.values()];
}

function scoreCompleteness(c) {
  return (c.role ? 3 : 0) + (c.company && c.company !== 'Unknown' ? 3 : 0) + (c.location ? 1 : 0) + (c.url ? 2 : 0);
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

function normalizeRole(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(sr|senior|jr|junior|ii|iii|iv)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function loadExistingIndex() {
  const urls = new Set();
  const roles = new Set();

  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) urls.add(cleanUrl(match[0]));
    for (const line of text.split('\n')) {
      const parts = line.split('|').map(s => s.trim());
      if (parts.length >= 5 && /^\d+$/.test(parts[1])) {
        roles.add(`${normalizeKey(parts[3])}::${normalizeRole(parts[4])}`);
      }
    }
  }

  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) urls.add(cleanUrl(match[0]));
    for (const line of text.split('\n')) {
      const m = line.match(/- \[[ x!]\]\s+(\S+)\s+\|\s+([^|]+)\s+\|\s+(.+)$/);
      if (m) roles.add(`${normalizeKey(m[2])}::${normalizeRole(m[3])}`);
    }
  }

  return { urls, roles };
}

function groupDuplicates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const roleKey = `${normalizeKey(candidate.company)}::${normalizeRole(candidate.role)}`;
    const key = roleKey.replace(/:+/g, '') ? `role::${roleKey}` : `url::${candidate.url}`;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        ...candidate,
        duplicateCount: 1,
        sources: [candidate.sourceMessage],
        evidenceSnippets: [candidate.evidence],
      });
      continue;
    }

    const isNewEvidence = !existing.evidenceSnippets.some(e => normalizeEvidence(e) === normalizeEvidence(candidate.evidence));
    if (isNewEvidence) existing.duplicateCount += 1;
    existing.sources.push(candidate.sourceMessage);
    if (!existing.url && candidate.url) existing.url = candidate.url;
    if (!existing.location && candidate.location) existing.location = candidate.location;
    if (scoreCompleteness(candidate) > scoreCompleteness(existing)) {
      existing.role = candidate.role;
      existing.company = candidate.company;
      existing.location = candidate.location || existing.location;
      existing.evidence = candidate.evidence;
    }
    existing.evidenceSnippets.push(candidate.evidence);
  }

  return [...groups.values()];
}

function normalizeEvidence(value) {
  return String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

function scoreCandidate(candidate, profile, existingIndex) {
  const text = `${candidate.role} ${candidate.company} ${candidate.location} ${candidate.evidence}`.toLowerCase();
  let score = 40;
  const reasons = [];

  let bestArchetype = 'General operations';
  let bestHits = 0;
  for (const archetype of ARCHETYPES) {
    const hits = archetype.terms.filter(term => text.includes(term));
    if (hits.length > bestHits) {
      bestHits = hits.length;
      bestArchetype = archetype.name;
    }
  }

  if (bestHits > 0) {
    score += 20 + Math.min(12, bestHits * 3);
    reasons.push(`${bestArchetype} match`);
  }

  const titleLower = candidate.role.toLowerCase();
  const positiveRole = (profile.target_roles?.primary || [])
    .some(role => titleLower.includes(String(role).toLowerCase().replace(/\s+analyst$/, '')));
  if (positiveRole) {
    score += 8;
    reasons.push('matches target role list');
  }

  const excluded = EXCLUDE_TITLE_WORDS.filter(word => text.includes(word));
  if (excluded.length) {
    score -= 25;
    reasons.push(`off-target title signals: ${excluded.slice(0, 2).join(', ')}`);
  }

  const seniorityRisks = SENIORITY_RISK_WORDS.filter(word => text.includes(word));
  if (seniorityRisks.length) {
    score -= 18;
    reasons.push(`likely above entry/mid target: ${seniorityRisks[0].trim()}`);
  } else if (SENIOR_WORDS.some(word => titleLower.includes(word))) {
    score -= 8;
    reasons.push('senior title, review level fit');
  }

  if (/\b(remote|hybrid|united states|usa|chicago|illinois|il)\b/i.test(`${candidate.location} ${candidate.evidence}`)) {
    score += 5;
    reasons.push('location likely workable');
  }

  const sponsorship = classifySponsorship(text, profile, candidate.role);
  if (sponsorship.status === 'Supportive') score += 8;
  else if (sponsorship.status === 'Incompatible') score -= 35;
  else if (sponsorship.status === 'Internship exception') score += 4;
  reasons.push(sponsorship.reason);

  const existingStatus = existingIndex.urls.has(candidate.url)
    ? 'Already in local pipeline/tracker'
    : existingIndex.roles.has(`${normalizeKey(candidate.company)}::${normalizeRole(candidate.role)}`)
      ? 'Possible local duplicate'
      : '';

  if (existingStatus) {
    score -= 12;
    reasons.push(existingStatus.toLowerCase());
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    score5: (score / 20).toFixed(1),
    label: score >= 75 ? 'Strong' : score >= 65 ? 'Good' : score >= 50 ? 'Review' : 'Low',
    archetype: bestArchetype,
    sponsorship: sponsorship.status,
    existingStatus,
    why: [...new Set(reasons)].slice(0, 5).join('; '),
  };
}

function classifySponsorship(text, profile, role) {
  const rejectIf = profile.job_search?.sponsorship_policy?.reject_if || [];
  const rejectTerms = [
    ...rejectIf,
    'will not sponsor',
    'no sponsorship',
    'unable to sponsor',
    'without sponsorship',
    'must be authorized to work',
  ].map(String);
  const supportTerms = ['sponsor', 'h-1b', 'h1b', 'opt', 'cpt', 'stem opt', 'visa support', 'work authorization support'];

  const isInternship = /\bintern(ship)?\b/i.test(role);
  if (isInternship && !rejectTerms.some(term => text.includes(term.toLowerCase()))) {
    return { status: 'Internship exception', reason: 'internship: sponsorship not required filter' };
  }

  const rejection = rejectTerms.find(term => text.includes(term.toLowerCase()));
  if (rejection) return { status: 'Incompatible', reason: `sponsorship blocker: ${rejection}` };

  const support = supportTerms.find(term => text.includes(term));
  if (support) return { status: 'Supportive', reason: `sponsorship signal: ${support}` };

  return { status: 'Unknown', reason: 'sponsorship unknown' };
}

function buildRows(groups, profile, existingIndex) {
  return groups.map(group => {
    const scoring = scoreCandidate(group, profile, existingIndex);
    const dates = group.sources.map(s => s.date).filter(Boolean).sort((a, b) => b - a);
    const latest = dates[0] || null;
    const sourceSubjects = [...new Set(group.sources.map(s => s.subject).filter(Boolean))].slice(0, 3);
    const sourceFrom = [...new Set(group.sources.map(s => s.from).filter(Boolean))].slice(0, 2);

    return {
      review_date: today(),
      source_email_date: latest ? latest.toISOString().slice(0, 10) : '',
      alert_source: sourceFrom.join(' | '),
      company: group.company,
      role: group.role,
      location: group.location || '',
      url: group.url || '',
      fit_score: scoring.score,
      fit_5: `${scoring.score5}/5`,
      fit_label: scoring.label,
      archetype: scoring.archetype,
      sponsorship: scoring.sponsorship,
      duplicate_count: group.duplicateCount,
      existing_status: scoring.existingStatus,
      why: scoring.why,
      email_subject: sourceSubjects.join(' | '),
    };
  }).sort((a, b) => b.fit_score - a.fit_score || b.duplicate_count - a.duplicate_count);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path, rows) {
  const headers = Object.keys(rows[0] || {
    review_date: '',
    source_email_date: '',
    alert_source: '',
    company: '',
    role: '',
    location: '',
    url: '',
    fit_score: '',
    fit_5: '',
    fit_label: '',
    archetype: '',
    sponsorship: '',
    duplicate_count: '',
    existing_status: '',
    why: '',
    email_subject: '',
  });
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => csvEscape(row[h])).join(','));
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

function writeTsv(path, rows) {
  const headers = Object.keys(rows[0] || {
    review_date: '',
    source_email_date: '',
    alert_source: '',
    company: '',
    role: '',
    location: '',
    url: '',
    fit_score: '',
    fit_5: '',
    fit_label: '',
    archetype: '',
    sponsorship: '',
    duplicate_count: '',
    existing_status: '',
    why: '',
    email_subject: '',
  });
  const clean = value => String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  const lines = [headers.join('\t')];
  for (const row of rows) lines.push(headers.map(h => clean(row[h])).join('\t'));
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

function writeMarkdown(path, rows, metadata) {
  const topRows = rows.slice(0, 25);
  const lines = [
    `# Job Alert Digest - ${metadata.date}`,
    '',
    `Parsed ${metadata.messages} recent email(s), extracted ${metadata.candidates} candidate row(s), grouped into ${metadata.groups} role(s).`,
    '',
    '| Fit | Company | Role | Location | Sponsorship | Dups | Existing | Why |',
    '|---|---|---|---|---|---:|---|---|',
  ];

  for (const row of topRows) {
    const role = row.url ? `[${escapePipe(row.role)}](${row.url})` : escapePipe(row.role);
    lines.push(`| ${row.fit_5} ${row.fit_label} | ${escapePipe(row.company)} | ${role} | ${escapePipe(row.location)} | ${row.sponsorship} | ${row.duplicate_count} | ${escapePipe(row.existing_status)} | ${escapePipe(row.why)} |`);
  }

  lines.push('', '## Suggested Morning Flow', '');
  lines.push('1. Open the CSV or TSV and sort by fit_score descending.');
  lines.push('2. Paste/import Strong and Good rows into Notion for manual review.');
  lines.push('3. For any row you want to pursue, run the normal Career-Ops evaluation/package flow.');
  lines.push('4. Keep Low rows out unless you have a specific reason to override.');
  lines.push('');
  writeFileSync(path, lines.join('\n'), 'utf-8');
}

function escapePipe(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function printSummary(rows, metadata, paths) {
  const counts = rows.reduce((acc, row) => {
    acc[row.fit_label] = (acc[row.fit_label] || 0) + 1;
    return acc;
  }, {});

  console.log(`Job Alert Digest - ${metadata.date}`);
  console.log('--------------------------------------------------');
  console.log(`Recent emails parsed: ${metadata.messages}`);
  console.log(`Candidates extracted: ${metadata.candidates}`);
  console.log(`Grouped roles:        ${metadata.groups}`);
  console.log(`Rows written:         ${rows.length}`);
  console.log(`Strong/Good/Review/Low: ${counts.Strong || 0}/${counts.Good || 0}/${counts.Review || 0}/${counts.Low || 0}`);
  console.log('');
  console.log('Outputs:');
  console.log(`  CSV:      ${paths.csv}`);
  console.log(`  TSV:      ${paths.tsv}`);
  console.log(`  Markdown: ${paths.md}`);
  console.log(`  JSON:     ${paths.json}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.input) {
    usage();
    throw new Error('Missing --input path');
  }

  const profile = readProfile();
  const files = collectFiles(args.input);
  if (files.length === 0) throw new Error(`No supported email files found under ${args.input}`);

  const allMessages = readMessages(files);
  const messages = allMessages.filter(message => messageWithinWindow(message, args));
  const candidates = messages.flatMap(extractCandidates);
  const groups = groupDuplicates(candidates);
  const existingIndex = loadExistingIndex();
  let rows = buildRows(groups, profile, existingIndex);

  if (!args.includeLowFit) rows = rows.filter(row => row.fit_score >= args.minScore);
  if (args.top && Number.isFinite(args.top)) rows = rows.slice(0, args.top);

  mkdirSync(args.outputDir, { recursive: true });
  const stem = `${today()}-job-alert-notion`;
  const paths = {
    csv: join(args.outputDir, `${stem}.csv`),
    tsv: join(args.outputDir, `${stem}.tsv`),
    md: join(args.outputDir, `${stem}.md`),
    json: join(args.outputDir, `${stem}.json`),
  };

  const metadata = {
    date: today(),
    files: files.length,
    messages: messages.length,
    candidates: candidates.length,
    groups: groups.length,
    minScore: args.includeLowFit ? 0 : args.minScore,
  };

  writeCsv(paths.csv, rows);
  writeTsv(paths.tsv, rows);
  writeMarkdown(paths.md, rows, metadata);
  writeFileSync(paths.json, JSON.stringify({ metadata, rows }, null, 2) + '\n', 'utf-8');
  printSummary(rows, metadata, paths);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
