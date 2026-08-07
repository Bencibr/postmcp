import dns from 'dns';
import fs from 'fs/promises';
import http from 'http';
import https from 'https';
import { isIP } from 'net';
import os from 'os';
import path from 'path';

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CONFIGURABLE_FILE_BYTES = 100 * 1024 * 1024;

const SENSITIVE_KEY_PATTERN = /(?:^|[_-])(authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passphrase|client[_-]?secret|secret|token|api[_-]?key|credential|session)(?:$|[_-])/i;
const SENSITIVE_PATH_SEGMENTS = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', 'gcloud',
]);
const SENSITIVE_FILE_NAMES = new Set([
  '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);

interface AllowlistEntry {
  pattern: string;
  allowPrivate: boolean;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseAllowlistEntry(raw: string): AllowlistEntry | null {
  let pattern = raw.trim().toLowerCase();
  if (!pattern) return null;

  let allowPrivate = false;
  if (pattern.startsWith('private:')) {
    allowPrivate = true;
    pattern = pattern.slice('private:'.length).trim();
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pattern)) {
    try {
      const parsed = new URL(pattern);
      pattern = parsed.host.toLowerCase();
    } catch {
      return null;
    }
  }

  return pattern ? { pattern, allowPrivate } : null;
}

function entryMatches(entry: AllowlistEntry, hostname: string, host: string): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedHost = host.toLowerCase();
  const pattern = entry.pattern;

  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`);
  }
  return normalizedHostname === normalizeHostname(pattern) || normalizedHost === pattern;
}

function matchingEntries(url: URL, allowlist: string[]): AllowlistEntry[] {
  return allowlist
    .map(parseAllowlistEntry)
    .filter((entry): entry is AllowlistEntry => entry !== null)
    .filter(entry => entryMatches(entry, url.hostname, url.host));
}

function hostnameEntries(hostname: string, allowlist: string[]): AllowlistEntry[] {
  const normalized = normalizeHostname(hostname);
  return allowlist
    .map(parseAllowlistEntry)
    .filter((entry): entry is AllowlistEntry => entry !== null)
    .filter(entry => {
      const pattern = entry.pattern.replace(/:\d+$/, '');
      if (pattern === '*') return true;
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        return normalized === suffix || normalized.endsWith(`.${suffix}`);
      }
      return normalized === normalizeHostname(pattern);
    });
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4ToInt(base);
  if (baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

export function isPrivateOrReservedIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateOrReservedIp(mapped);

  if (isIP(normalized) === 4) {
    const value = ipv4ToInt(normalized)!;
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, prefix]) => inIpv4Range(value, String(base), Number(prefix)));
  }

  if (isIP(normalized) === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    const firstGroup = parseInt(normalized.split(':')[0] || '0', 16);
    return (firstGroup >= 0xfc00 && firstGroup <= 0xfdff)
      || (firstGroup >= 0xfe80 && firstGroup <= 0xfebf)
      || (firstGroup >= 0xff00)
      || normalized.startsWith('2001:db8:');
  }

  return true;
}

function privateAccessAllowed(hostname: string, allowlist: string[]): boolean {
  const normalized = normalizeHostname(hostname);
  const entries = hostnameEntries(normalized, allowlist);
  if (entries.some(entry => entry.allowPrivate)) return true;
  return normalized === 'localhost' && entries.some(entry => entry.pattern.replace(/:\d+$/, '') === 'localhost')
    || isIP(normalized) !== 0 && entries.some(entry => normalizeHostname(entry.pattern.replace(/:\d+$/, '')) === normalized);
}

export function assertUrlAllowedSync(
  urlStr: string,
  allowlist: string[],
  allowedProtocols: string[] = ['http:', 'https:'],
): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Access Denied: Invalid outbound URL "${urlStr}".`);
  }

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(`Access Denied: Protocol "${parsed.protocol}" is not allowed.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Access Denied: Credentials embedded in URLs are not allowed.');
  }
  if (allowlist.length === 0) {
    throw new Error('Access Denied: The outbound URL allowlist is empty. Configure explicit domains first.');
  }
  if (matchingEntries(parsed, allowlist).length === 0) {
    throw new Error(`Access Denied: Host "${parsed.host}" is not in the outbound URL allowlist.`);
  }
  return parsed;
}

export async function assertSafeOutboundUrl(
  urlStr: string,
  allowlist: string[],
  allowedProtocols: string[] = ['http:', 'https:'],
): Promise<URL> {
  const parsed = assertUrlAllowedSync(urlStr, allowlist, allowedProtocols);
  const addresses = await dns.promises.lookup(normalizeHostname(parsed.hostname), { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`Access Denied: Host "${parsed.hostname}" did not resolve.`);

  if (!privateAccessAllowed(parsed.hostname, allowlist)) {
    const blocked = addresses.find(address => isPrivateOrReservedIp(address.address));
    if (blocked) {
      throw new Error(`Access Denied: Host "${parsed.hostname}" resolves to private or reserved address ${blocked.address}. Use a private: allowlist entry only for trusted internal hosts.`);
    }
  }
  return parsed;
}

export function createSafeLookup(allowlist: string[]): any {
  return (hostname: string, options: any, callback: any) => {
    const normalizedOptions = typeof options === 'number' ? { family: options } : { ...(options || {}) };
    const wantsAll = normalizedOptions.all === true;
    dns.lookup(hostname, { ...normalizedOptions, all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      const resolved = addresses as unknown as dns.LookupAddress[];
      if (!resolved.length) return callback(new Error(`Access Denied: Host "${hostname}" did not resolve.`));
      if (!privateAccessAllowed(hostname, allowlist)) {
        const blocked = resolved.find(address => isPrivateOrReservedIp(address.address));
        if (blocked) return callback(new Error(`Access Denied: DNS resolution for "${hostname}" returned private or reserved address ${blocked.address}.`));
      }
      if (wantsAll) return callback(null, resolved);
      return callback(null, resolved[0].address, resolved[0].family);
    });
  };
}

function redirectUrlFromOptions(options: any): string {
  const protocol = options.protocol || 'http:';
  const hostname = options.hostname || options.host;
  const port = options.port ? `:${options.port}` : '';
  const requestPath = options.path || '/';
  return `${protocol}//${hostname}${port}${requestPath}`;
}

export function createSafeRequestOptions(
  allowlist: string[],
  initialUrl: string,
  allowedProtocols: string[] = ['http:', 'https:'],
  blockCrossOriginRedirects = false,
): Record<string, any> {
  const lookup = createSafeLookup(allowlist);
  const initialOrigin = new URL(initialUrl).origin;
  return {
    // Do not let Axios route an otherwise validated destination through an
    // ambient HTTP(S)_PROXY value. The proxy host would become the actual
    // socket destination and could bypass the hostname/IP policy above.
    proxy: false,
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
    maxRedirects: 5,
    beforeRedirect: (options: any) => {
      const redirectUrl = redirectUrlFromOptions(options);
      const parsed = assertUrlAllowedSync(redirectUrl, allowlist, allowedProtocols);
      if (blockCrossOriginRedirects && parsed.origin !== initialOrigin) {
        throw new Error(`Access Denied: Cross-origin redirect from "${initialOrigin}" to "${parsed.origin}" is not allowed for credentialed requests.`);
      }
    },
  };
}

export function assertOAuthTransport(url: URL): void {
  const hostname = normalizeHostname(url.hostname);
  const isLoopback = hostname === 'localhost'
    || hostname === '::1'
    || (isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new Error('Access Denied: OAuth token endpoints must use HTTPS except for explicit loopback development endpoints.');
  }
}

function configuredFileRoots(): string[] {
  const configured = process.env.POSTMCP_FILE_ROOTS;
  if (configured) return configured.split(path.delimiter).filter(Boolean).map(root => path.resolve(root));

  const cwd = path.resolve(process.cwd());
  const home = path.resolve(os.homedir());
  const filesystemRoot = path.parse(cwd).root;
  return cwd === home || cwd === filesystemRoot ? [] : [cwd];
}

function isSensitivePath(realPath: string): boolean {
  if (process.env.POSTMCP_ALLOW_SENSITIVE_FILES === 'true') return false;
  const normalized = realPath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some(segment => SENSITIVE_PATH_SEGMENTS.has(segment))) return true;
  const fileName = path.basename(normalized);
  return SENSITIVE_FILE_NAMES.has(fileName) || /^\.env(?:\.|$)/.test(fileName) || /private[_-]?key/.test(fileName);
}

export async function resolveAllowedFile(filePath: string): Promise<{ path: string; size: number }> {
  const roots = configuredFileRoots();
  if (roots.length === 0) {
    throw new Error('File Access Denied: Configure POSTMCP_FILE_ROOTS with one or more explicit directories before using local file tools.');
  }

  const requested = path.resolve(filePath);
  const realPath = await fs.realpath(requested);
  const realRoots = await Promise.all(roots.map(async root => {
    try { return await fs.realpath(root); } catch { return path.resolve(root); }
  }));
  const insideRoot = realRoots.some(root => realPath === root || realPath.startsWith(`${root}${path.sep}`));
  if (!insideRoot) throw new Error(`File Access Denied: "${filePath}" is outside POSTMCP_FILE_ROOTS.`);
  if (isSensitivePath(realPath)) throw new Error(`File Access Denied: "${filePath}" matches a protected credential or sensitive configuration path.`);

  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error(`File Access Denied: "${filePath}" is not a regular file.`);
  const configuredLimit = Number(process.env.POSTMCP_MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES);
  const maxBytes = Math.min(Math.max(1, Number.isFinite(configuredLimit) ? configuredLimit : DEFAULT_MAX_FILE_BYTES), MAX_CONFIGURABLE_FILE_BYTES);
  if (stat.size > maxBytes) throw new Error(`File Access Denied: "${filePath}" is ${stat.size} bytes; limit is ${maxBytes} bytes.`);
  return { path: realPath, size: stat.size };
}

export async function readAllowedFile(filePath: string): Promise<Buffer> {
  const resolved = await resolveAllowedFile(filePath);
  return fs.readFile(resolved.path);
}

export async function readAllowedTextFile(filePath: string): Promise<string> {
  const resolved = await resolveAllowedFile(filePath);
  return fs.readFile(resolved.path, 'utf8');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(`_${normalized}_`);
}

export function redactSensitiveData(value: any, maskSecrets = true): any {
  if (Array.isArray(value)) return value.map(item => redactSensitiveData(item, maskSecrets));
  if (value && typeof value === 'object') {
    const output: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) && maskSecrets ? '********' : redactSensitiveData(item, maskSecrets);
    }
    return output;
  }
  return value;
}

export function redactHeaders(headers: Record<string, any>, extraSensitiveKeys: string[] = []): Record<string, string> {
  const extras = new Set(extraSensitiveKeys.map(key => key.toLowerCase()));
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    output[key] = isSensitiveKey(key) || extras.has(key.toLowerCase()) ? '********' : String(value);
  }
  return output;
}

export function redactBody(body: any, maskSecrets = true): string {
  if (body === undefined || body === null || body === '') return '';
  if (typeof body === 'object') return JSON.stringify(maskSecrets ? redactSensitiveData(body) : body, null, 2);

  const text = String(body);
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(maskSecrets ? redactSensitiveData(parsed) : parsed, null, 2);
  } catch {
    if (!maskSecrets) return text;
    return text
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ********')
      .replace(/((?:password|passphrase|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie)\s*[=:]\s*)([^&\s,;]+)/gi, '$1********');
  }
}
