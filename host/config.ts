// 读 host/config.json。相对路径一律按配置文件所在目录解析。
// 密钥只从 apiKeyFile 读一行,不进环境变量、不打日志;这里也不把它放回配置对象里到处传。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface HostConfig {
  port: number;
  dbPath: string;
  apiKeyFile: string;
  anthropicBaseUrl?: string;
  authToken: string;
  ownerToken: string;
  companionToken?: string;
  companionCommentWrite: boolean;
  allowedOrigins: string[];
  defaultModel?: string;
  segmentsModule?: string;
  fakeModel: boolean;
  frontendDir: string;
  schemaDir: string;
}

const HOST_DIR = import.meta.dirname;
export const DEFAULT_CONFIG_PATH = resolve(HOST_DIR, 'config.json');
const UPSTREAM_DIR = resolve(HOST_DIR, '../upstream');

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function loadConfig(path = DEFAULT_CONFIG_PATH): HostConfig {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: any) {
    throw new Error(`读不了配置 ${path}:${error?.code === 'ENOENT' ? '文件不存在(先 cp host/config.example.json host/config.json)' : error?.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`配置 ${path} 不是 JSON 对象`);
  const base = dirname(resolve(path));
  const rel = (p: string) => (p ? resolve(base, p) : '');

  const port = raw.port === undefined ? 3889 : Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port 必须是 1–65535 的整数');
  const authToken = str(raw.authToken);
  // 口令是 URL 的第一段路径,只收 URL 里不用转义的字符,免得前端拼地址和这边比对对不上。
  if (!authToken) throw new Error('authToken 必填(书房 API 的路径口令)');
  if (!/^[A-Za-z0-9._~-]{8,}$/.test(authToken)) throw new Error('authToken 至少 8 位,只能用字母、数字和 . _ ~ -');
  const dbPath = str(raw.dbPath);
  if (!dbPath) throw new Error('dbPath 必填');
  const apiKeyFile = str(raw.apiKeyFile);
  if (!apiKeyFile) throw new Error('apiKeyFile 必填(放 Anthropic API key 的文件)');

  const origins = Array.isArray(raw.allowedOrigins)
    ? raw.allowedOrigins.map(str).filter(Boolean)
    : str(raw.allowedOrigins).split(',').map((s) => s.trim()).filter(Boolean);

  return {
    port,
    dbPath: dbPath === ':memory:' ? dbPath : rel(dbPath),
    apiKeyFile: rel(apiKeyFile),
    anthropicBaseUrl: str(raw.anthropicBaseUrl) || undefined,
    authToken,
    ownerToken: str(raw.ownerToken),
    companionToken: str(raw.companionToken) || undefined,
    companionCommentWrite: raw.companionCommentWrite === true,
    allowedOrigins: origins,
    defaultModel: str(raw.defaultModel) || undefined,
    segmentsModule: str(raw.segmentsModule) ? rel(str(raw.segmentsModule)) : undefined,
    fakeModel: raw.fakeModel === true,
    frontendDir: str(raw.frontendDir) ? rel(str(raw.frontendDir)) : resolve(UPSTREAM_DIR, 'frontend/out'),
    schemaDir: resolve(UPSTREAM_DIR, 'examples/cloudflare/schema'),
  };
}

// 读 key 文件的第一行非空内容。出错只说文件路径,不带内容。
export function readApiKey(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error: any) {
    throw new Error(`读不了 apiKeyFile(${file}):${error?.code || 'unknown'}`);
  }
  const key = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!key) throw new Error(`apiKeyFile(${file})是空的`);
  return key;
}
