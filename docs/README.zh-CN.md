# PicoShare 中文使用说明

基于 Cloudflare Workers + D1 + R2 的轻量文件分享服务。

前端使用 Svelte 5 + Tailwind CSS 4，界面为中文；Worker 使用 Hono 路由，并通过 Hono RPC 把每个接口的响应类型直接推导给前端。

## 功能

- 密钥登录的管理界面
- 文件上传（选择、拖拽、粘贴文本），100MB 以上自动分片上传并显示进度
- 图片模式：粘贴截图（Ctrl+V）、图片画廊（缩略图懒加载 + 灯箱 + 搜索）、一键复制直链/Markdown/HTML/BBCode
- 图床工具集成：接口返回绝对 `url`/`markdown`/`bbcode`，支持 PicGo 自定义 Web 图床与裸二进制上传接口
- 图片按 SHA-256 去重：内容相同的图片复用已存储的内容（秒传，备注与有效期不生效），但每次上传仍会生成自己的分享链接；访客上传仅在同一个访客链接内去重
- 文件/图片列表服务端分页与文件名搜索、批量删除
- 文件列表、元数据编辑、同名替换并保留历史版本、单个历史版本删除
- 访客链接上传（限制大小、次数、有效期；上传次数通过原子预留防止并发超限）
- 下载记录（支持按 IP 去重查看；HEAD 与画廊预览不计入）
- 过期文件自动清理、废弃分片上传自动清理（定时任务 + 请求内兜底）
- 直链支持 HTTP Range 与 `If-None-Match`，视频/音频可拖动播放
- 基础限流（登录失败与访客上传，按 IP、单 isolate 内存计数）

## 1. 环境准备

1. 安装 Node.js（建议 `>=20`）与 pnpm（`corepack enable` 或 `npm i -g pnpm`）。
2. 安装依赖：

```bash
pnpm install
```

3. 登录 Cloudflare：

```bash
npx wrangler login
```

## 2. 创建 Cloudflare 资源

### 2.1 创建 D1 数据库

```bash
npx wrangler d1 create picoshare_db
```

执行后会返回 `database_id`，把它写入 `wrangler.jsonc` 的 `d1_databases[].database_id`（该文件已入库，直接改）。

### 2.2 创建 R2 Bucket

```bash
npx wrangler r2 bucket create picoshare-files
```

把 Bucket 名称写入 `wrangler.jsonc` 的 `r2_buckets[].bucket_name`（同样是直接改该文件）。

## 3. 本地配置

1. 新建密钥文件 `.dev.vars`（在仓库根目录，不会被提交），里面写一行：

```
PS_SHARED_SECRET=<你自己的强口令>
```

2. 修改 `wrangler.jsonc`：

  - `database_id` 填第 2.1 步拿到的 D1 ID（全零不是可用 ID，部署会失败）
  - `bucket_name` 填第 2.2 步创建的 R2 名称

Worker 没有默认密钥，也不会在启动时检查：漏写这一行它照样能启动，只是所有受保护接口（包括登录本身）都会返回 `401`。

## 4. 初始化数据库

结构定义在 `schema.sql`（可重复执行，新库与存量库结果一致）。本地初始化：

```bash
pnpm d1:init
```

远程（生产）初始化：

```bash
pnpm d1:init:remote
```

`schema.sql` 使用 `CREATE TABLE IF NOT EXISTS`，因此**新增索引**可以直接生效，但**新增/重命名列不会**：存量表不会被改动。改列时要么写一条 `ALTER TABLE` 语句单独执行，要么按下面的方式重建：

本项目不提供迁移目录；schema 变化时若涉及列结构，直接在 Cloudflare 控制台删除并重建 D1 数据库，再执行上面的初始化命令即可。

## 5. 启动与测试

本地启动（同时启动 Worker 与前端）：

```bash
pnpm dev
```

- Worker：`http://127.0.0.1:8787`
- 前端开发服务器：`http://127.0.0.1:5173`（API 自动代理到 Worker）

只启动 Worker：

```bash
pnpm dev:worker
```

质量检查：

```bash
pnpm typecheck
pnpm test
```

## 6. 部署

1. 配置生产密钥：

```bash
npx wrangler secret put PS_SHARED_SECRET
```

> **这一步是公开部署与敞开的唯一区别。** 运行时既没有默认密钥，也不检查是否漏配或仍是占位值：
> 没设置密钥的部署，所有受保护接口与登录一律返回 `401`；而设置了 `replace-me`、`changeme`
> 这类示例值的部署，等于真的用这个值当口令。本地开发把同一个值写进仓库根目录、已被 git 忽略的
> `.dev.vars`，只有一行：`PS_SHARED_SECRET=<你自己的强口令>`

2. 初始化远程数据库（仅新部署需要，脚本可重复执行）：

```bash
pnpm d1:init:remote
```

3. 构建前端并发布：

```bash
pnpm deploy
```

Worker 通过 `ASSETS` 绑定提供 `apps/web/dist` 中的静态资源，未匹配的路径会回退到 SPA 首页。API 与前端由**同一个 Worker** 应答：SPA 兜底依赖该绑定，浏览器端又写死了同源调用，两者无法在不改动代码的前提下拆开。`wrangler.jsonc` 默认配置了每小时执行一次的维护任务（清理过期文件与废弃分片上传）。

`main` 分支推送后会自动部署（需在仓库配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`）。部署由一个 `ci` 任务把关：类型检查、单元测试、把 `schema.sql` 在临时库上执行两遍、前端构建，以及一次冒烟——用 `wrangler dev` 启动真实运行时，再用 `curl` 走一遍无密钥被拒、上传成功、两个公开直链可用、SPA 兜底能从 `ASSETS` 绑定返回。除了这次冒烟，没有任何环节真正跑过 Worker：那些测试都是 mock，所以打包、绑定和路由顺序只有在这里才会一起被验证。前端以构建产物交给部署任务，而不是重新构建，因此上线的就是通过测试的那份字节。部署前会先执行 `schema.sql`，它是幂等的——但只会新增表与索引，不会给已有表加列。

## 7. 配置

### 7.1 密钥

本地密钥放在仓库根目录的 `.dev.vars`（已被 git 忽略），只有一行，没有模板可复制：

```
PS_SHARED_SECRET=<你自己的强口令>
```

生产环境用 Worker secret：

```bash
npx wrangler secret put PS_SHARED_SECRET
```

它**不在** `wrangler.jsonc` 里——该文件已入库，一旦出现密钥赋值测试就会失败——也**不在**
部署工作流里，因为 Actions 里的密钥就是运行日志里的密钥。

运行时不会检查这个值：未设置时受保护接口全部 `401`（`platform/http.ts` 失败即拒绝），
而占位值就是一个能用的口令。上面「部署」一节才是需要抓住这件事的地方。

### 7.2 Worker 配置

`wrangler.jsonc` 已入库。没有模板也不需要复制：不在仓库里的文件无法复现一次部署，而这份文件
不含任何私密内容。

| 配置项 | 含义 |
|---|---|
| `name` | Worker 名称，也决定 `workers.dev` 子域名 |
| `main` | `apps/worker/src/index.ts` |
| `assets` | `apps/web/dist` 与 `ASSETS` 绑定，SPA 兜底依赖它 |
| `d1_databases` | `DB` 绑定 |
| `r2_buckets` | `BUCKET` 绑定 |
| `triggers.crons` | 每小时的维护任务 |
| `compatibility_date` | 固定的运行时行为，说明写在文件里 |
| `vars` | 仅 `PUBLIC_ORIGIN`，且仅在会转发原始 `Host` 的代理之后需要 |

其中两个值因部署而异，首次部署前必须替换：`d1_databases[].database_id`
（`npx wrangler d1 create picoshare_db` 会打印）与 `r2_buckets[].bucket_name`。两者都不是凭据，
所以才可以放在仓库里。

R2 bucket 名只能包含小写字母、数字和连字符：`picoshare_files` 会被名称校验拒绝，且
`wrangler dev` 直接拒绝启动而不是警告。D1 没有这条规则，这正是下划线看起来也该可行的原因。

API 与前端由**同一个 Worker** 应答，因此改前端也要重新部署一次 Worker，API 不可用时站点
整体不可用。拆开会需要路由表和可配置的客户端 base URL，而 SPA 兜底又依赖那个绑定。

### 7.3 数据库结构

结构定义在 `schema.sql`，且是幂等的：`pnpm d1:init`（本地）与 `pnpm d1:init:remote` 都可以
重复执行，CI 也会对着一个临时库执行两遍来保证这一点。

幂等不等于可迁移。`schema.sql` 只写 `CREATE TABLE IF NOT EXISTS`，它会**新增索引**，
但绝不会新增或重命名列。所以对着旧结构建出来的库重跑一次会报成功、什么也不改，
而代码会在每一次读到那个被改名的列时失败。**本项目没有迁移路径**——预期的部署方式是用
当前 `schema.sql` 建一个全新库，所以不存在需要偿还的升级路径。

这个失败是被识别过的，不会只返回一个裸 `500`：响应里出现 `数据库结构与代码不匹配` 就是它，
解决办法是重建。

```bash
rm -rf .wrangler/state && pnpm d1:init
```

`.wrangler/state` 同时装着本地数据库**和**桶，所以在做这件事之前，备份它就是备份全部。
关于它有两点值得知道：改 `database_id` 会连本地数据库一起换目录（Miniflare 按 id 分区），
旧文件会被留在原地而不是被删掉。

### 7.4 安全检查清单

- 不要提交 `.dev.vars`、`.env*`、私钥或证书文件；已入库的 `wrangler.jsonc` 同样不得包含它们。
- 密钥泄露后立即更换 `PS_SHARED_SECRET`。
- 优先使用请求头鉴权。query 形式的密钥只在一个路由上被接受（`POST /api/entry`），因为
  URL 里的密钥会进入访问日志和 `Referer`。
- 分享链接与图片链接**按设计公开**——id 就是访问凭证——所以 id 由 CSPRNG 生成 16 位，
  且不得缩短。

## 8. 图床工具集成（PicGo / ShareX / uPic）

管理接口认证方式（三选一）：

- `Authorization: <PS_SHARED_SECRET>`
- `X-Api-Key: <PS_SHARED_SECRET>`
- `?token=<PS_SHARED_SECRET>`（仅用于无法自定义请求头的工具，注意 URL 会进入日志）

### 8.1 PicGo「自定义 Web 图床」

1. 安装 PicGo 的自定义 Web 上传插件（`picgo-plugin-web-uploader`）。
2. 配置示例：
   - POST 地址：`https://<你的域名>/api/entry`
   - 表单字段名：`file`
   - 请求头：`Authorization: <PS_SHARED_SECRET>`
   - JSON 路径：`$.url`
3. 上传成功后返回示例：

```json
{
  "id": "abc123",
  "filename": "photo.png",
  "version": 1,
  "sha256": "...",
  "deduped": false,
  "url": "https://<域名>/img/abc123/photo.png",
  "markdown": "![photo.png](https://<域名>/img/abc123/photo.png)",
  "bbcode": "[img]https://<域名>/img/abc123/photo.png[/img]"
}
```

### 8.2 裸二进制上传

与 7.1 是**同一个接口**，只是请求体格式不同：请求的 `Content-Type` 不是
`multipart/form-data` 时，整个请求体就是文件本身，文件名放在网址参数里。

```bash
curl -X POST "https://<域名>/api/entry?filename=photo.png&token=<PS_SHARED_SECRET>" \
  -H "Content-Type: image/png" --data-binary @photo.png
```

返回结构与 7.1 完全相同。超过 100MB 的文件请使用 Web 界面（自动分片上传）。

> 如果你的工具支持表单模式（PicGo、ShareX、uPic 都支持），直接用 7.1 即可，不需要这一节。
> 裸数据通道是为「配置界面里只能选原始数据」或「命令行一行脚本」准备的。

> 说明：R2 的 S3 API token 也可以让 PicGo 直传 R2，但那样会绕过 Worker/D1，图片不会出现在图库中，也没有 `/img/<id>/<filename>` 直链。推荐使用上面的 Worker 接口。

## 9. 常用命令

- 列出 D1：
```bash
npx wrangler d1 list
```
- 查看 R2 Bucket：
```bash
npx wrangler r2 bucket list
```
- 查看已部署 Worker：
```bash
npx wrangler deployments list
```
- 查看远程表结构：
```bash
npx wrangler d1 execute picoshare_db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

## 10. 维护任务

- 触发方式：`wrangler.jsonc` 的 `triggers.crons`（默认每小时）；同时每次请求会做一次限频兜底（同一 isolate 60 秒一次）。
- 清理内容：已过期条目（R2 对象 + D1 记录）、超过 24 小时未完成的分片上传。

## 11. 安全注意事项

- `.dev.vars` 含敏感配置，已被 git 忽略，不要提交；仓库里没有它的模板文件。
- `wrangler.jsonc` 已入库，但**不得包含密钥**——有测试会在出现密钥赋值时失败。
- 密钥泄露后请立即更换 `PS_SHARED_SECRET`。
- 管理接口需要密钥；访客的 `/api/guest/:id/info` 与 `/api/guest/:id/upload` 为公开接口。
- 分享链接 `/-<id>` 与图片链接 `/img/<id>/<文件名>` **按设计公开**，不校验密钥：id 本身就是访问凭证，因此由 CSPRNG 生成（16 位、约 93 bit 熵）。
- 下载与预览响应策略（`/-<id>`、`/img/<id>/<filename>`、`/api/entry/<id>/preview`）：
  - 仅图片/视频/音频/PDF/纯文本内联展示；
  - HTML、XML、JS 一律 `Content-Disposition: attachment`，避免存储型 XSS；
  - SVG 强制附件并附带 `Content-Security-Policy: default-src 'none'; sandbox`；
  - 所有内容响应带 `X-Content-Type-Options: nosniff`，图片缓存 `max-age=86400`；
  - 支持 `Range`（206）与 `If-None-Match`（304）。
- 限流为单 isolate 内存计数，只做基础防护，不替代 Cloudflare WAF / Rate Limiting 规则。

## 12. 图片直链

- 形态：`https://<域名>/img/<id>/<原始文件名>`（如 `/img/abc123/photo.png`）。
- 访问文件名与实际文件名不一致时会 302 跳转到规范地址。
- 直链与 `/-<id>` 一样计入下载记录（仅 GET）；画廊与详情页预览走鉴权接口，不计入。
