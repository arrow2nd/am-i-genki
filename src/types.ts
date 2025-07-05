// 環境変数の型定義
export interface Env {
  GITHUB_USERNAME: string;
  HEALTHY_THRESHOLD?: string;
  MODERATE_THRESHOLD?: string;
  MONITORING_DAYS?: string;
  CACHE_TTL?: string;
  JST_UPDATE_HOUR?: string;
  GITHUB_TOKEN?: string;
  INCLUDE_ORG_REPOS?: string;
  MAX_REPOS_PER_ORG?: string;
  EXCLUDE_REPOS?: string;
  EXCLUDE_ORGS?: string;
  AM_I_GENKI_CACHE: KVNamespace;
}

// キャッシュデータの型定義
export interface CacheData {
  commits: number;
  status: "healthy" | "moderate" | "inactive";
  lastUpdated: string;
  sources: { owned: number; org: number };
}

// 設定の型定義
export interface Config {
  username: string;
  healthyThreshold: number;
  moderateThreshold: number;
  monitoringDays: number;
  cacheTTL: number;
  jstUpdateHour: number;
  githubToken?: string;
  includeOrgRepos: boolean;
  maxReposPerOrg: number;
  excludeRepos: string[];
  excludeOrgs: string[];
}

// GitHub APIレスポンスの型定義
export interface GitHubRepo {
  name: string;
  updated_at: string;
}

export interface GitHubCommit {
  author?: { login: string };
  commit: {
    author: {
      name: string;
      email: string;
    };
  };
  parents: Array<{ sha: string }>;
}

export interface GitHubOrg {
  login: string;
}

// バッジスタイルの型定義
export const VALID_BADGE_STYLES = [
  "flat",
  "flat-square",
  "plastic",
  "for-the-badge",
  "social",
] as const;

export type BadgeStyle = typeof VALID_BADGE_STYLES[number];

// 元気度ステータスの型定義
export type HealthStatus = "healthy" | "moderate" | "inactive";

