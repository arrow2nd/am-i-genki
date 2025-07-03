# Am I Genki?

![元気？](https://genki-badge.arrow2nd.workers.dev/badge)

☹️
GitHubユーザーの直近のコミット活動を元に「元気度」を判定し、READMEに貼れるSVGバッジを生成するやつ

## 📋 必要なもの

- Cloudflareアカウント
- Node.js とか Bun とか

## 🚀 セットアップ

### 1. リポジトリのクローン

```bash
git clone https://github.com/your-username/am-i-genki.git
cd am-i-genki
```

### 2. 依存関係のインストール

```bash
npm install
# または
bun install
```

### 3. KVネームスペースの作成

```bash
npx wrangler kv namespace create "AM_I_GENKI_CACHE"
```

`wrangler.sample.jsonc` をコピーして `wrangler.jsonc` を作成。
出力された`id`を`wrangler.jsonc`の`YOUR_KV_NAMESPACE_ID`部分に設定してください。

### 4. 環境変数の設定

`wrangler.jsonc`を編集：

```jsonc
"vars": {
    "GITHUB_USERNAME": "your-github-username",  // 必須：監視対象のGitHubユーザー名
    "HEALTHY_THRESHOLD": "15",     // 元気判定のしきい値（デフォルト: 15）
    "MODERATE_THRESHOLD": "5",     // そこそこ判定のしきい値（デフォルト: 5）
    "MONITORING_DAYS": "14",      // 監視期間（日数、デフォルト: 14日間）
    "CACHE_TTL": "86400",         // キャッシュ保持時間（秒、デフォルト: 24時間）
    "JST_UPDATE_HOUR": "8",       // JST更新時刻（0-23、デフォルト: 朝8時）
    "INCLUDE_ORG_REPOS": "false", // 組織リポジトリを含むか（デフォルト: false）
    "MAX_REPOS_PER_ORG": "5",     // 組織あたりの読み込む最大リポジトリ数（デフォルト: 5）
    "EXCLUDE_REPOS": "dotfiles",  // 除外するリポジトリ（カンマ区切り、デフォルト: なし）
    "EXCLUDE_ORGS": ""            // 除外する組織（カンマ区切り、デフォルト: なし）
}
```

### 5. GitHub Personal Access Token（推奨）

レート制限を緩和するため、GitHub Personal Access Tokenの設定を推奨します：

```bash
npx wrangler secret put GITHUB_TOKEN
# プロンプトでトークンを入力
```

必要な権限：`public_repo`のみ

> [!TIP]
> PATの期間が無制限だと Org の情報にアクセスできないので注意かも

### 6. デプロイ

```bash
npm run deploy
```

## 🎨 使い方

### Markdownに貼り付け

```markdown
![元気？](https://your-worker-domain.workers.dev/badge)
```

### スタイル指定

styleパラメータは flat, flat-square, plastic, for-the-badge, social
のいずれかが指定できます。

```markdown
![元気？](https://your-worker-domain.workers.dev/badge?style=flat-square)
![元気？](https://your-worker-domain.workers.dev/badge?style=for-the-badge)
```

## 🔧 API エンドポイント

### `GET /badge`

元気度バッジのSVGを返します。

**クエリパラメータ：**

- `style`: バッジのスタイル（オプション）
  - `flat` (デフォルト)
  - `flat-square`
  - `plastic`
  - `for-the-badge`
  - `social`

**使用例：**

```
/badge?style=flat-square
/badge?style=for-the-badge
```

**レスポンスヘッダー：**

- `X-Commits`: 監視期間内のコミット数
- `X-Status`: 元気度ステータス（healthy/moderate/inactive）
- `X-Username`: 対象ユーザー名

### `GET /health`

サービスの稼働状況を確認できます。

## 🔍 動作の仕組み

1. **Botユーザーチェック**: ユーザー名とコミット情報でBotでないことを確認
2. **コミット数集計**:
   所有リポジトリと組織リポジトリから指定期間内のコミットを集計
3. **キャッシュ管理**: JST指定時刻で1日1回更新、KVに保存
4. **バッジ生成**: SVG形式で動的に生成

## ⚙️ 開発

### ローカル実行

```bash
npm run dev
```

http://localhost:8787 でアクセス可能

### テスト実行

```bash
npm test
```

### 型定義の更新

```bash
npm run cf-typegen
```

## 📝 注意事項

- GitHub APIのレート制限：未認証時60req/h、認証時5000req/h
- Botアカウントとマージコミットは自動的に除外されます
- 組織リポジトリはパブリックのみ対象
- プライベートリポジトリのコミットは、適切な権限のあるトークンが必要です
