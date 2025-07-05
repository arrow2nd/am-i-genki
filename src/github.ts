import type { Config, GitHubCommit, GitHubRepo, GitHubOrg } from "./types";
import { fetchWithRetry } from "./utils";
import { isBotAccount } from "./utils";

// GitHub APIヘッダー
export function getGithubHeaders(token?: string): HeadersInit {
  const headers: HeadersInit = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "Am-I-Genki-Badge-Service",
  };
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  return headers;
}

// 単一リポジトリのコミット数を取得
export async function getRepoCommits(
  username: string,
  repoOwner: string,
  repoName: string,
  since: Date,
  token?: string,
): Promise<number> {
  try {
    const commitsResponse = await fetchWithRetry(
      `https://api.github.com/repos/${repoOwner}/${repoName}/commits?author=${username}&since=${since.toISOString()}&per_page=100`,
      { headers: getGithubHeaders(token) },
      3,
      500,
    );

    if (commitsResponse.ok) {
      const commits = await commitsResponse.json() as GitHubCommit[];

      // Bot・マージコミットを除外してユーザー本人のコミットのみカウント
      const userCommits = commits.filter((commit) => {
        const authorLogin = commit.author?.login;
        const authorName = commit.commit.author.name;
        const authorEmail = commit.commit.author.email;

        // マージコミット（親が2つ以上）を除外
        const isMergeCommit = commit.parents.length >= 2;

        return !isBotAccount(authorLogin, authorName, authorEmail) &&
          !isMergeCommit &&
          authorLogin === username;
      });

      return userCommits.length;
    }
  } catch (error) {
    console.error(`Error fetching commits for ${repoName}:`, error);
  }

  return 0;
}

// 組織リポジトリのコミット数を取得
export async function getOrgRepoCommits(
  username: string,
  config: Config,
  since: Date,
  maxRepos: number,
): Promise<{ commits: number; repos: number }> {
  let totalOrgCommits = 0;
  let processedOrgRepos = 0;

  try {
    // ユーザーが所属する組織を取得
    const orgsResponse = await fetchWithRetry(
      `https://api.github.com/users/${username}/orgs`,
      { headers: getGithubHeaders(config.githubToken) },
    );

    if (!orgsResponse.ok) {
      console.error("Failed to fetch user organizations");
      return { commits: 0, repos: 0 };
    }

    const orgs = await orgsResponse.json() as GitHubOrg[];

    // 除外組織をフィルタリング
    const filteredOrgs = orgs.filter((org) =>
      !config.excludeOrgs.includes(org.login)
    );

    // 組織ごとのリポジトリを並列取得
    const orgReposPromises = filteredOrgs.map(async (org) => {
      try {
        const orgReposResponse = await fetchWithRetry(
          `https://api.github.com/orgs/${org.login}/repos?type=public&sort=updated&per_page=${config.maxReposPerOrg}`,
          { headers: getGithubHeaders(config.githubToken) },
        );

        if (orgReposResponse.ok) {
          const repos = await orgReposResponse.json() as GitHubRepo[];
          return { org: org.login, repos };
        }
        return null;
      } catch (error) {
        console.error(`Error fetching repos for org ${org.login}:`, error);
        return null;
      }
    });

    const orgReposResults = await Promise.all(orgReposPromises);

    // 全てのリポジトリをフラット化して処理
    const allOrgRepos: Array<
      { org: string; repo: GitHubRepo }
    > = [];

    for (const result of orgReposResults) {
      if (result && result.repos) {
        for (const repo of result.repos) {
          if (allOrgRepos.length >= maxRepos) break;

          const repoUpdated = new Date(repo.updated_at);
          if (
            repoUpdated >= since && !config.excludeRepos.includes(repo.name)
          ) {
            allOrgRepos.push({ org: result.org, repo });
          }
        }
      }
    }

    // バッチサイズ
    const batchSize = config.githubToken ? 5 : 3;

    // バッチ処理でコミット数を確認
    for (
      let i = 0;
      i < allOrgRepos.length && processedOrgRepos < maxRepos;
      i += batchSize
    ) {
      const batch = allOrgRepos.slice(
        i,
        Math.min(i + batchSize, allOrgRepos.length),
      );

      const batchPromises = batch.map(async ({ org, repo }) => {
        try {
          const commits = await getRepoCommits(
            username,
            org,
            repo.name,
            since,
            config.githubToken,
          );

          if (commits > 0) {
            return { commits, org, repo: repo.name };
          }
          return null;
        } catch (error) {
          console.error(`Error processing ${org}/${repo.name}:`, error);
          return null;
        }
      });

      const results = await Promise.all(batchPromises);

      for (const result of results) {
        if (result && processedOrgRepos < maxRepos) {
          totalOrgCommits += result.commits;
          processedOrgRepos++;
        }
      }

      // バッチ間の小さな遅延
      if (i + batchSize < allOrgRepos.length && processedOrgRepos < maxRepos) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.githubToken ? 100 : 200)
        );
      }
    }
  } catch (error) {
    console.error("Error fetching organization repositories:", error);
  }

  return { commits: totalOrgCommits, repos: processedOrgRepos };
}

// コミット数の取得（組織リポジトリ対応版）
export async function getCommitCount(
  username: string,
  monitoringDays: number,
  config: Config,
): Promise<{ commits: number; sources: { owned: number; org: number } }> {
  // 指定日数前の日付を計算
  const since = new Date();
  since.setDate(since.getDate() - monitoringDays);

  let totalCommits = 0;
  let processedRepos = 0;
  const repoSources = { owned: 0, org: 0 };

  // ユーザーの所有リポジトリを取得・処理
  const ownedRepos = await fetchWithRetry(
    `https://api.github.com/users/${username}/repos?type=owner&sort=updated&per_page=30`,
    { headers: getGithubHeaders(config.githubToken) },
  );

  if (ownedRepos.ok) {
    const repos = await ownedRepos.json() as GitHubRepo[];

    // 処理対象のリポジトリをフィルタリング
    const reposToProcess = repos
      .filter((repo) => {
        if (processedRepos >= 20) return false;
        if (config.excludeRepos.includes(repo.name)) return false;
        const repoUpdated = new Date(repo.updated_at);
        return repoUpdated >= since;
      })
      .slice(0, 20);

    // バッチサイズ（同時実行数）
    const batchSize = config.githubToken ? 5 : 3;

    // バッチ処理で並列化
    for (let i = 0; i < reposToProcess.length; i += batchSize) {
      const batch = reposToProcess.slice(i, i + batchSize);

      const batchPromises = batch.map(async (repo) => {
        try {
          const commits = await getRepoCommits(
            username,
            username,
            repo.name,
            since,
            config.githubToken,
          );

          if (commits > 0) {
            return { commits, isOwned: true };
          }
          return null;
        } catch (error) {
          console.error(`Error processing repo ${repo.name}:`, error);
          return null;
        }
      });

      const results = await Promise.all(batchPromises);

      for (const result of results) {
        if (result) {
          totalCommits += result.commits;
          repoSources.owned++;
          processedRepos++;
        }
      }

      // バッチ間の小さな遅延
      if (i + batchSize < reposToProcess.length) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.githubToken ? 100 : 200)
        );
      }
    }
  }

  // 組織リポジトリも含める場合
  if (config.includeOrgRepos && processedRepos < 20) {
    const orgResult = await getOrgRepoCommits(
      username,
      config,
      since,
      20 - processedRepos,
    );
    totalCommits += orgResult.commits;
    repoSources.org = orgResult.repos;
    processedRepos += orgResult.repos;
  }

  return { commits: totalCommits, sources: repoSources };
}