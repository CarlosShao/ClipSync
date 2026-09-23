# P0-C / C2 证据：修 CI 的"三重假绿"与缺失门禁

- 票：P0-C C2（F2 / F3 / F4）
- 分支：`test/admin-full-audit`
- 作者范围：仅 `.github/**` + 本证据文件
- 状态：**已完成**（在 `.github/**` 权限范围内）。未 commit / 未 push / 未打 tag / 未触发任何运行 / 未动 GitHub 设置。
  阻塞与待拍板项见 §6（U1–U8）；批次期间收到的越权或失实"转述批准"及逐条处置见 §8、§8b。
- 凭据自查：对 6 个 `.env*` 文件做字面量反扫，17 处命中**全部**是已出现在 git 追踪文件里的公共占位值，
  无一处是本机独有凭据（详见 §7 末尾）。任何真实 secret 值都没进 workflow / 注释 / 日志 / 本文件。

---

## 0. 一句话结论（先给判据本身的死活）

`ci.yml` 最后一次真跑 **32467333008 / 2026-08-21T09:19:28Z**：`Test Files 1 failed | 12 passed`、`Tests 1 failed | 123 passed | 48 skipped`，
但 `Lint`、`Tests` 两个 job 与整个 workflow 的 conclusion 都是 `success`。→ **F2 成立，且是实测成立（有 run id + 有日志行）**。

`deploy.yml` 更糟：**它从来没运行过一次**。见 §1.4。

---

## 1. 锚点逐条复核（真实行号 = 改动前的 `HEAD` 版本）

复核方式：`Read` 打开文件 + `gh run view --log` + 本地复跑同名命令。

### 1.1 `.github/workflows/ci.yml`

| 锚点（票面给的） | 实际内容 | 复核结论 |
|---|---|---|
| `:10` `:12` 只触发 master | `push: branches: [master]` / `pull_request: branches: [master]` | ✅ 成立 |
| `:56` lint `\|\| true` | `npx eslint src/ --ext .js --max-warnings=0 \|\| true` | ✅ 成立，**且比票面更糟**：这条命令从来就没 lint 过任何东西，见 §1.5 |
| `:68` 步骤结尾 `\|\| true` | 飞书通知 `curl ... \|\| true` | ✅ 成立（通知类，属可保留） |
| `:76` `continue-on-error: true` | `test` job 级 | ✅ 成立 |
| `:156` `continue-on-error: true` | "Run tests" 步骤级（与 :76 双层中和） | ✅ 成立 |
| `:168` `\|\| true` | 飞书通知 | ✅ 成立（可保留） |
| `:240` `\|\| true` | `find ... \| head -10 \|\| true`（远端诊断输出） | ✅ 成立（可保留，纯诊断） |
| `:281` `\|\| true` | `git log -1 --oneline > .last_deploy_commit \|\| true` | ✅ 成立，**但不可保留**：这一行写的是**回滚锚点**，静默失败 = 出事时没有可回退的版本号 |
| `:289` `:291` `:293` `\|\| true` | `restart backend` 三连（prod / dev / 裸 compose） | ✅ 成立，**"服务不存在"这条也被我独立证实**，见 §1.3 |
| `:299` `:300` `\|\| true` | `docker compose ps` / `docker compose logs --tail=20 backend` | ✅ 成立，**另有一处票面没写**：这两句没带 `-f docker-compose.prod.yml`，而 `docker-compose.yml`（裸文件）**一个 services 都没有**，所以即便不带 `\|\| true` 它也只能打印空表 |
| `:314` `\|\| true` | 飞书通知 | ✅ 成立（可保留） |
| —（票面未列）`:199` | `deploy` job 级 `continue-on-error: true` | ⚠️ **票面漏了一条**：整个部署 job 失败也不红。这是第四层中和 |
| —（票面未列）`:195`+`:284-285` | `deploy` 是 `workflow_dispatch`，但远端固定 `git fetch origin master && git reset --hard origin/master` | ⚠️ 从非 master 分支点"Run workflow"，被测的是那个分支、被部署的是 master。job 结论却按被测分支报"部署成功" |

### 1.2 `.github/workflows/deploy.yml`

| 锚点 | 实际内容 | 复核结论 |
|---|---|---|
| `:97` `continue-on-error: true` | Trivy 镜像扫描步骤 | ✅ 成立 |
| `:104` `continue-on-error: true` | 上传 trivy sarif | ✅ 成立（上传类可容忍，但要改成"失败可见"） |
| `:163` `\|\| true` | `kubectl rollout status **statefulset**/clipsync-postgres` | ✅ 成立，**且这一句永远失败**：`k8s/base/postgres.yaml:31` 起，`clipsync-postgres` 是 `kind: Deployment`，不是 StatefulSet。`|| true` 把一个恒假断言伪装成"等数据库就绪" |
| `:110` `needs: build-and-push` | `deploy-k8s` 只依赖构建 | ✅ 成立 |
| `:266` `needs: deploy-k8s` | `release` 只依赖部署 | ✅ 成立 |
| `:323` `needs: [deploy-k8s, release, rollback-if-failed]` | `notify` | ✅ 成立 |
| —（票面未列）`:89-91` | Trivy `image-ref: ...:${{ github.sha }}`（40 位全 SHA），但 `:66-70` 的 metadata-action 只推 `type=sha,prefix=`（短 SHA）与 semver tag | ⚠️ 扫描的是**一个从来没被 push 过的 tag** → 就算拿掉 `continue-on-error`，Trivy 也只会以"镜像拉不到"失败，扫不到漏洞 |
| —（票面未列）`:21` | `IMAGE_NAME: ${{ github.repository }}/clipsync-server` → `ghcr.io/CarlosShao/ClipSync/clipsync-server` | ⚠️ ghcr 强制镜像名小写，含大写的 `CarlosShao/ClipSync` 会被 registry 拒绝 |
| —（票面未列）`:267` | `release` job 的 `if: success() && !env.IS_PRERELEASE` | ⚠️ job 级 `if` 拿不到 `env` 上下文（`env` 只在 step 级可用）→ 整个 workflow 文件加载失败，见 §1.4 |
| —（票面未列）`:299` | `needs.build-andpush.outputs.digest`（少一个连字符） | ⚠️ 引用不存在的 job → Release 正文里 Digest 恒空（静默） |

`.github/workflows/admin-console.yml`、`website.yml`：**没有任何 `\|\| true` / `continue-on-error`**（已全文核对）。
但 `admin-console.yml:5` 的触发分支写的是 `['feature/admin-console', 'dev/cnb', 'main']` —— 本仓库**没有 `main` 分支**（`git symbolic-ref refs/remotes/origin/HEAD` → `origin/master`），且当前 P0-B/P0-D 正在改的 `src/admin-console/**` 都在 `test/admin-full-audit` 上 → 这个 workflow 对本次改动同样是瞎的。

### 1.3 "restart backend 重启了一个不存在的服务" —— 独立证实，票面成立

查真实服务名（用仓库已有的 `js-yaml@4.3.2`，未新增依赖）：

| 文件 | services | 有 `backend` 吗 |
|---|---|---|
| `docker-compose.yml` | **（无 services 段，只有 networks + volumes）** | ❌ |
| `docker-compose.dev.yml` | `clipsync-db`, `clipsync-redis`, **`clipsync`**, `minio`, `minio-init` | ❌（API 服务叫 `clipsync`） |
| `docker-compose.prod.yml` | `postgres-prod`, `redis-prod`, **`api-prod`**, `backup` | ❌（API 服务叫 `api-prod`） |
| `docker-compose.multi.yml` | `postgres`, `redis`, `api-1`, `api-2`, `nginx`, `backup` | ❌ |
| `k8s/base/*.yaml` | `Deployment/clipsync-api`, `Deployment/clipsync-postgres`, `Deployment/clipsync-redis` | ❌（K8s 侧也叫 api 不叫 backend） |

⇒ **全仓没有任何一处叫 `backend` 的服务**。三连 `docker compose ... restart backend` 三次全部 `no such service`，被 `|| true` 吞掉，然后 `:295` 无条件 `echo "✅ 后端已重启"`。
结论：**这条部署从来不会部署任何东西，但它每次都报成功**。F2 的这一节不需要推翻。

### 1.4 F4 的实测加重：`deploy.yml` 一次都没跑过

```
$ gh run list --workflow 303882987 --limit 200 --json conclusion,createdAt,event,headBranch
oldest=2026-06-29T06:33:40Z  newest=2026-09-21T12:11:42Z  total=198
[{"conclusion":"failure","n":198}]        # 198/198 全红
$ gh run view 35598124612 --json name,jobs
{"name":".github/workflows/deploy.yml","jobs":[],"conclusion":"failure","event":"push","branch":"test/admin-full-audit"}
```

读法：`name` 退化成了**文件路径**（正常应是 `Deploy - Production`）+ `jobs: []` + 触发事件是**分支 push**（而 `:13-17` 只声明了 tag 触发）—— 这是 GitHub "workflow 文件加载失败" 的签名。
所以：**deploy.yml 自 2026-06-29 建file 以来没有执行过一个 job**，198 条记录全是加载失败。

推论（重要，影响你怎么看待 F4）：
- 票面说"tag 一打就直接上生产 K8s，前面没有任何门禁"—— **结构上成立**（`needs` 链里确实没有测试），但 **经验上不成立**（打了 tag 也不会部署，文件加载不了）。
- 真正在跑的"生产变更通道"其实只有 `ci.yml` 的 `deploy` job（SSH 到单机 `git reset --hard origin/master` + `restart backend`），而它重启的是一个不存在的服务 ⇒ 单机部署路径也是假的。
- 因此给 deploy.yml 加门禁是"把一个从没通过的管子修通并顺手加闸"，不是"在一条已经跑着的流水线上插闸门"。风险方向完全不同，见 §5。

未核实项：`environment: production`（`:111`）有没有配 required reviewers、`secrets` 是否齐全 —— 我没有（也不被允许）读 GitHub 设置，**未能核实**。

### 1.5 "lint 永不失败" 的下半段：它连一次都没 lint 成功

```
$ cd src/server && npx eslint src/ --ext .js --max-warnings=0
npm warn exec The following package was not found and will be installed: eslint@10.11.0
Oops! Something went wrong! :(
ESLint: 10.11.0
ESLint couldn't find an eslint.config.* file.
exit code = 2
```
- `src/server/package.json` 的 devDependencies 只有 `supertest`、`vitest` —— **没有 eslint**。`npx eslint` 因此在 CI 里**每次从 npm 现拉一个 floating 版本**（不走 lockfile，本身是供应链面）。
- 全仓 `src/server` 下**没有任何 `.eslintrc*` / `eslint.config.*`**（`find` 结果：无）。拉到的 eslint 10 只认 flat config ⇒ 必然 exit 2。
- 与线上日志一致（`gh run view --log --job 96726630853`，2026-08-21 那次 Lint job）：

```
Lint  UNKNOWN STEP  ...ESLint couldn't find an eslint.config.* file.
Lint  UNKNOWN STEP  ...If you are using a .eslintrc.* file, please follow the migration guide
```
⇒ `:56` 的 `|| true` 吞掉的不是"有 3 个 warning"，而是"linter 根本没跑"。这一 job 的 `success` 是纯粹的假绿。
⇒ 副作用：**去掉 `|| true` 后 lint job 会立刻变红**，且我无权（"不许新增依赖"）也无法修好它 ⇒ 见 §6 未完成项 U1。

### 1.6 F3 的下半段：现在这份配置在 CI 里必然连不上库（精确根因 + 引入时间点）

`src/server/src/config.js:44`：

```js
if (nodeEnv !== 'test' && (process.env.DB_HOST || process.env.DB_PORT || ...)) { ... }
```
⇒ **NODE_ENV=test 时，`DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` 被刻意忽略**，一切以 `src/server/src/config/test.js` 的字面值为准：
`host=localhost, port=5433, name=clipsync_test, user=clipsync, password=<test.js 里的公共默认串>`。

而 `ci.yml:77-88` 现在给的是 `DB_PORT: 5432`、`DB_USER: postgres`，service container 也发布在 5432 且用户是 `postgres` ⇒ **四处全对不上**。

时间线核对（这条解释了两件事）：
```
$ git log -S "测试环境强制使用 testConfig" --oneline -- src/server/src/config.js
777ee645 2026-08-24 test(env): 测试库隔离(clipsync_test) + 同步 scripts 基线迁移(036 幂等)
$ gh run list --workflow "CI/CD - ClipSync" --limit 1   # 最后一次实跑
32467333008  2026-08-21T09:19:28Z  success  master
```
⇒ 8-21 那次能连上库（当时 DB_PORT env 覆盖还生效，或 test.js 端口不同）；**8-24 之后这段抑制逻辑落地，CI 的测试 job 就必红了**——只是因为它挂着 `continue-on-error` 且触发分支只有 master，从来没人看到。
⇒ 本机侧证据：`src/server/docker-compose.dev.yml` 的 `clipsync-db` 映射 `${DB_PORT:-5433}:5432`，与 test.js 的 5433 一致 —— 5433 是**本地开发者视角**，CI 里没有这个映射。

另外发现（同族，票面没提）：
- `package.json` 的 `test:env` = `bash scripts/start-test-env.sh`，而 **`scripts/start-test-env.sh` 在仓库里不存在**（`ls scripts/` 无此文件）⇒ 文档化的"起测试库"入口是死的。
- `src/server/src/utils/redis-map.js:24` 有**真语法错误**（非 async 函数里 `await redisClient.connect()`），`node --check` 直接 SyntaxError ⇒ 该模块一旦被 import 就崩。**在我禁改的 `src/server/src/**` 里，未动，只登记**（见 U3）。
- 该文件还独立读 `process.env.REDIS_HOST/REDIS_PORT`，默认 **6379**（而 test.js 是 6380）⇒ workflow 侧必须显式注入 REDIS_* 三件套才能两边一致（见 §4）。

---

## 2. 被去掉的中和手段，以及它此前会漏掉什么

### ci.yml

| 位置（原行号） | 原写法 | 处理 | 此前会漏掉什么 |
|---|---|---|---|
| `:10` `:12` | `branches: [master]`（push/PR） | 改为 `branches-ignore: [archive/**, backup/**]` + PR `**` + `workflow_dispatch`（理由见 §3） | 2026-08-21 之后 39 个新测试文件（16→55 个 .test.js）从未进过 CI，任何回归都不会被发现 |
| `:56` | `npx eslint ... \|\| true` | 拆成两步：`Syntax gate (node --check)` 真门禁 + `Lint gate` 先做确定性探测、探测不到即 `exit 1` 并打印修法 | 吞掉的不是 warning 而是"linter 根本没跑"（§1.5）；8-21 那次这一步也照样报 success |
| `:76` | job 级 `continue-on-error: true`（test） | 删除 | 唯一的服务端测试门禁被完全解除；8-21 那次 `1 failed` 仍报 success |
| `:156` | step 级 `continue-on-error: true`（Run tests） | 删除 | 与 :76 叠成双层；即使 job 级被拿掉它还会单独把测试失败抹平 |
| `:199` | job 级 `continue-on-error: true`（deploy） | 删除 | **票面漏记的第四层中和**：SSH 部署整个失败也不会红。最后一次 dispatch 是 2026-08-09，从没人验过它的结论可信 |
| `:281` | `git log -1 > .last_deploy_commit \|\| true` | 改 `git rev-parse HEAD > .last_deploy_commit`（不吞）+ 追加 `.last_deploy_log` | 静默丢掉回滚锚点：出事时不知道该回哪个版本 |
| `:289` `:291` `:293` | `restart backend \|\| true` 三连 | 先 `docker compose config --services` 校验服务真实存在，再 `up -d --build <api-prod\|clipsync>`；识别不出 compose 文件即 `exit 1` | 见下方"两层错误" |
| `:299` `:300` | `docker compose ps/logs`（无 `-f`）`\|\| true` | 与重启同一个 `-f`，且只在"已判失败的分支"里作为取证保留 | `ps` 看的是那个没有 services 的裸 `docker-compose.yml`，恒空表 ⇒ "服务状态正常"的错觉 |
| （新增） | — | 部署后强制 `/api/health` 200，否则 `exit 1` | 原脚本 `sleep 5` 后直接宣布"🎉 部署完成"，完全没有"起没起来"的判断 |
| （新增） | — | `if` 加 `github.ref == 'refs/heads/master'` | 从 feature 分支点按钮时，被测的是分支、被部署的是 master，结论却按分支报 |

`restart backend` 的**两层**错误（第二层票面没写）：
1. 服务名 `backend` 在本仓库任何 compose/k8s 形态里都不存在（§1.3）⇒ 命令必失败。
2. 即使名字写对，**`restart` 在生产形态下也部署不了新代码**：`docker-compose.prod.yml` 的 `api-prod` 只挂载 `uploads/backups`，应用代码来自 `build: context ./src/server` 的镜像 ⇒ 容器里跑的还是旧镜像，`git reset --hard` 与它无关。
   例外：`docker-compose.dev.yml` 的 `clipsync` 把 `./src/server/src:/app/src:ro` 挂进去了，dev 形态下 `restart` 确实生效。有代理据此主张"原写法能部署新代码、F2 该推翻"—— 该主张只对 dev 成立，对 deploy job 实际优先选中的 prod 不成立 ⇒ **不推翻 F2**。

### deploy.yml

| 位置（原行号） | 原写法 | 处理 | 此前会漏掉什么 |
|---|---|---|---|
| `:97` | Trivy `continue-on-error: true` | 删除；`exit-code:'1'` + `severity: CRITICAL,HIGH` + `ignore-unfixed` 成为真门禁 | 镜像漏洞门禁 = 0 |
| `:91` | `image-ref: ...:${{ github.sha }}` | 改扫本次真正 push 的 `<lowercase-ref>:<version>` | 扫的是一个从未 push 过的 tag ⇒ 就算拿掉中和，也只会以"拉不到镜像"失败，永远扫不出漏洞 |
| `:104` | 上传 SARIF `continue-on-error: true` | 拆成三步：`Check SARIF presence`（写 output）→ `Upload Trivy SARIF to Security tab`（条件为文件存在）→ 另存一份 90 天构建产物 | 中和不再需要：用条件判断替代，既不抹平门禁，也不会因为缺文件让 upload-sarif 报错盖掉真实失败原因 |
| `:110` | `deploy-k8s.needs: build-and-push` | `needs: [verify, build-and-push]` | 见 §5（发布门禁） |
| `:137` | `kustomize edit set image ... ${{ env.IMAGE_NAME }}` | 改用 `needs.build-and-push.outputs.image_ref`（全小写） | ghcr 拒绝含大写的镜像路径 ⇒ push 必失败（文件从没跑过，所以没人撞见过） |
| `:163` | `rollout status **statefulset**/clipsync-postgres \|\| true` | 改 `deployment/clipsync-postgres`，删 `\|\| true`，timeout 120s→300s | 资源类型写错（`k8s/base/postgres.yaml` 是 Deployment）⇒ 恒失败被吞 ⇒ "数据库已就绪"是假的 |
| `:178` `:185` | `curl /health`、`/health/ready` | 改 `/api/health`、`/api/ready`；readiness 非 200 直接 `exit 1` | 服务端只有 `/api/health`、`/api/ready`（`src/server/src/index.js:276/284`；k8s 探针本来就写的 `/api/*`）⇒ 恒 404 |
| `:242` | 回滚验证同样 curl `/health` | 改 `/api/health` | 回滚成没成功永远判不出来 |
| `:267` | `release.if: success() && !env.IS_PRERELEASE` | 改 `!contains(github.ref_name,'-')` | job 级 `if` 取不到 `env` ⇒ 极可能就是 198 次加载失败的成因（§1.4） |
| `:299` | `needs.build-andpush.outputs.digest`（少连字符） | 改 `build-and-push` | Release 正文 Digest 恒空 |
| `:266` | `release.needs: deploy-k8s` 却取 `needs.build-and-push.*` | needs 补 `build-and-push`（同链，不改语义） | `needs` 只暴露直接依赖 ⇒ 版本号在 Release 标题里静默变空 |
| `:323` | `notify.needs` 同上 | needs 补 `build-and-push` | 通知正文里的版本恒空 |
| （新增） | `secrets.K8S_*` 直接插进 `--from-literal` | 前置"任一为空即拒绝部署"检查（只看存在性，从不打印值） | 某个 secret 没配时，会把生产密钥**静默刷成空串** |

保留的 `\|\| true`（逐条判定为"本质可选 + 后果已写清"）：
- `ci.yml:330` 远端 `find ... | head -10`：纯诊断，失败后果 = 少一行日志。
- `ci.yml:417/418`、`deploy.yml:409`：位于**已经判定失败、下一行就 exit 1** 的分支里，作用是"取证日志拉不到时不要把真实错误码盖掉"。
- 三处飞书通知：原为 `\|\| true`（完全静默），现改为 `\|\| echo "::warning::…"` —— 仍不阻塞判定，但失败在 run 页面可见。

### admin-console.yml / website.yml

两个文件都**没有** `\|\| true` / `continue-on-error`（全文核对）。唯一问题是 `admin-console.yml:5` 的触发分支写了不存在的 `main`（本仓库默认分支是 master），已按与 ci.yml 同一套分支形态改写。`website.yml` 用 `branches: ['**']`，无问题，未改。

---

## 3. 触发面覆盖（取舍与理由）

最终形态：`push.branches-ignore: ['archive/**', 'backup/**']` + `pull_request.branches: ['**']` + `workflow_dispatch`。

- 为什么用**排除式**而不是列举在用分支：我最初写的是列举法（master + `dev/** feature/** fix/** test/** release/**`），但列举法只能覆盖"我今天*观察到*的分支形态"（`git branch -a` 实读），明天新开 `chore/*`、`spike/*` 就又漏了 —— 漏一个分支 = 那批改动没有判据，而这正是 F3 的成因（只列 master 才导致 39 个测试文件从未进 CI）。排除式对未来的分支命名默认有判据。
- 排除 `archive/**`、`backup/**`：`archive/desktop-v1`、`archive/split-refactor-20260827`、`backup/split-refactor-20260827` 是冻结快照，对它们跑全量 `npm ci` + 测试只是白烧 runner 分钟。
- 注意别混淆两件事：`branches-ignore` 按**分支名**排除；`paths-ignore` 排除的是"改动涉及的文件路径"。**用 `paths-ignore: archive/**` 并不能让 `archive/desktop-v1` 分支不触发**（有转述建议这么写，未采纳，理由在此）。
- 因为排除式把那两类分支彻底关掉了，所以 `admin-console.yml` 我补了 `workflow_dispatch`（它原来没有手动入口），否则冻结分支再也没有办法按需跑一次。
- 代价（明写）：push + PR 同时命中时一次改动会跑两份 job。已依赖文件既有的 `concurrency.cancel-in-progress` 缓解；没有进一步改成"只 PR 跑测试"，因为**直接 push 到工作分支也是真实写入**，不能没有判据。

## 3b. timeout-minutes（本轮后段补，属同一族：卡住 ≠ 判据）

所有 9 个 job 都加了 `timeout-minutes`。理由不是"防超时"，而是：**挂住的 job 会一直显示 in progress，比红更难被发现**——单机 SSH 部署里还有 `ssh` + `curl` 重试环，网络半死时能挂很久。

| job | 上限 | 依据 |
|---|---|---|
| ci.yml `lint` / `test` | 15 / 20 | 2026-08-21 实跑 Tests ≈ 7s、Lint ≈ 9s；8× 余量 |
| ci.yml `deploy` | 45 | 远端现拉 npm + `up -d --build`（冷缓存十几分钟）+ 健康重试最长 3 轮 ×10 次 ≈ 20 分钟 |
| deploy.yml `verify` | 20 | 与 ci.yml test 同一套检查 |
| deploy.yml `build-and-push` | 60 | buildx 冷缓存建镜像 + Trivy 拉 DB 扫分层 |
| deploy.yml `deploy-k8s` | 25 | rollout 300+300+120s + 10×15s + readiness ≈ 15 分钟 |
| deploy.yml `rollback-if-failed` / `release` / `notify` | 15 / 10 / 5 | 都是收尾型 job，必须能在主链失败后**真的跑起来**（rollback 尤其：它一挂就没回滚） |
| admin-console `verify` / website `build` | 20 / 15 | 前端构建 + MSW 测试 |

一句纠正（多次转述里都出现的说法）："加 timeout 是为了让 `rollback-if-failed` 有时间跑回滚" —— 不成立。回滚 job 的触发是 `if: failure() && needs.deploy-k8s.result == 'failure'`，而 job 级 `timeout-minutes` **只作用于该 job 自己**；主链的 `timeout` 不会取消它的 `needs` 关系，回滚本来就有自己的 15 分钟。timeout 与回滚是两件事。
另：`ci.yml` 的 SSH 部署路径**没有**自动回滚（只有 `.last_deploy_commit` 锚点 + 失败时打印回滚提示），本轮不加 —— 那是一项新能力，不属"修判据仪器"。


---

## 4. service container 的最终形态与依据

结论：**测试模式下 workflow 能注入的只有 Redis 三件套和 JWT；DB 五件套被 `config.js:44` 明确忽略 ⇒ 只能让容器去迁就 `src/config/test.js` 的字面值。**

| 项 | 值 | 依据 |
|---|---|---|
| Postgres 宿主端口 | **5433**（`5433:5432`） | `src/config/test.js` db.port=5433；原 CI 用 5432 ⇒ 连不上 |
| POSTGRES_USER / DB | `clipsync` / `clipsync_test` | 同上 db.user / db.name（原 CI 是 `postgres`） |
| POSTGRES_PASSWORD | 复制 test.js 里那个已在仓库明文提交的公共默认口令（非真实凭据；生产侧另有 `config.js` 的 `INSECURE_*` 黑名单拦截） | 测试模式不接受 `DB_PASSWORD` env ⇒ 无第二个选择 |
| health-cmd | `pg_isready -U clipsync -d clipsync_test` | 原 `pg_isready` 不带 `-U/-d`，用户/库改名后健康判定会失真 |
| Redis 宿主端口 | `6380:6379` | `test.js` redis.port=6380；`tests/e2e.test.js:41-44` 读 `REDIS_PORT` env ⇒ 两侧一致 |
| Redis 口令 | `command: redis-server --requirepass <与 job env REDIS_PASSWORD 同值>` | `test.js` 的 redis.password 非空 ⇒ node-redis 会对无口令服务端发 AUTH 被拒。原 CI 的 redis **没有 requirepass** |
| job env 里刻意**不再**声明 `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` | — | 留着等于留一个"我配过了"的假象（它们根本不生效） |
| 新增 `Drift guard` 步 | 读 `src/config/test.js` 与容器接线逐项比对，不一致即红 | 这套"抄 test.js"的接线一定会腐坏；宁可在这里红，也不要红成"测试连不上库"那种看不懂的形状 |
| 新增 `Guard — tests actually executed` | 先脱 ANSI 色再匹配 vitest 汇总行；`No test files found` 即红 | 防"0 用例也绿"。脱色是必要的：8-21 真实日志的汇总行是 `^[[2m Test Files ...`，直接 grep 会在**成功**运行上误报红 |

未修改 `src/server/src/**` 与 `src/server/tests/**` 的任何一行；**不需要为连上库而改应用代码**（硬约束未被触发）。
唯一值得回交给你的架构性建议（不属本票、我一个字没动）：`config.js:44` 那段"测试期忽略 DB_*"让 CI 与任何自动化只能靠**复制字面值**连库；改成"env 优先、缺省回落 test.js"，上表前三行和 drift guard 都不再需要。

---

## 5. deploy 前置门禁：选型、对发布动作的影响、如何回退

**选型：在 deploy.yml 里内联一个 `verify` job（静态检查 + 服务端测试），并让 `build-and-push` 与 `deploy-k8s` 都 `needs` 它。**

为什么不选另两种：
- `workflow_run`（等 ci.yml 跑完再放行）：它绑的是**默认分支**那次运行的完成事件，而 tag 指向的 SHA 与那次运行的 SHA 不保证同一个；用它断言"这个 tag 被测过"，恰好在最需要它的时刻（多分支并行、tag 打在非 master 提交上）会说谎。
- 环境审批（`environment: production` + required reviewers）：那是"有人按批准"，不是"测试通过"；而且属于 GitHub 设置项，本票明令不许动。
- 抽成 reusable workflow 让两边共用：最干净，但"被 `workflow_call` 调用的工作流能否带 `jobs.<id>.services`"我没有可靠依据，且本票不许"跑一次看看"。为了不把**唯一还在跑的那件仪器**（ci.yml）送上手术台，本轮选择内联 + 显式登记重复（U4）。

Trivy 已按票面做成像样门禁（CRITICAL/HIGH 未修复即失败），不是"只让失败可见"。

**上线这次改动后，团队的发布动作会发生什么变化**

1. `ci.yml`：**立刻变红，而且红得是对的**。两处新暴露：
   - `Syntax gate` 抓到 `src/server/src/utils/redis-map.js:24` 的真语法错误（非 async 函数里 `await`）。该文件目前全仓**零 import**（`grep -rl redis-map src tests` → 0 命中）⇒ 这正是它能带着语法错误活到今天的原因。
   - `Lint gate` 因 eslint 不在依赖里而失败（U1）。
   - 连带效果：`deploy` 是 `needs: [lint, test]` ⇒ **单机 SSH 发布会被卡住**，直到 U1/U2 处理掉。这是有意的，门禁的意义就在这儿。
2. `ci.yml` 的 SSH 部署：从"任何分支都能点"变成**只有 master 能点**；从"`restart backend` 空转也报成功"变成"必须看到 `/api/health` 200"；动作从 `restart` 变成 `up -d --build`（生产形态必须重建镜像才有效）。
3. `deploy.yml`（tag → K8s）：**对今天的实际发布没有可观测影响** —— 它 198 次全部倒在加载阶段、0 个 job（§1.4）。也就是说门禁是加在一条从未通过流的管子上。反过来说，若我对它可加载性的判断错了，**第一次推 `v*` tag 会先被 verify/Trivy 拦住而不是静默上线** —— 这正是要的方向。
4. 谁会被拦：打 `v*` tag 的人（在 verify 步被拦，而不是在生产集群上被拦）；点 ci.yml 部署按钮的人（被 lint/测试拦）。
5. 怎么绕过（**都是 owner 的手，不是我的**）：
   - 最老实：补 eslint（U1）+ 修/删 redis-map.js（U2），一次红换永久绿。
   - 临时：把 `ci.yml` 里 `Lint gate` 那一步的 `exit 1` 注掉一行（改动会留在 history 里），或直接在服务器上手动 `docker compose -f docker-compose.prod.yml up -d --build api-prod`。
   - **未采纳**给 lint 加 `vars.SKIP_LINT` 一类开关（有代理转述"owner 已批准"）：一个仓库变量就能让门禁静默变绿，等于把这轮拆掉的假绿换个更隐蔽的形态装回去，而且在 run 页面上"job skipped"与"job green"对操作者几乎同形。
6. 如何回退本票：**revert 本票那一个 commit 即可** —— 只动 `.github/workflows/{ci,deploy,admin-console}.yml` 三个文件，不改应用代码、不动数据库、不动 GitHub 环境/密钥、不碰任何 secret。回退后恢复的就是"全绿但什么都拦不住"的原状（= F2/F3/F4 原样回来）。

---

## 6. 未完成 / 阻塞（需要 owner 拍板的都标了）

| # | 事项 | 缺哪一步 | 建议 |
|---|---|---|---|
| **U1** | lint 仍真不了 | `src/server` 无 eslint 依赖、无任何 eslint 配置文件；**本票禁新增依赖** | 批准 `npm i -D eslint` + 一份匹配配置（flat config，或锁 v8 + `.eslintrc.cjs`）。装好后 `Lint gate` 的探测自动放行，无需再改 workflow |
| **U2** | `src/server/src/utils/redis-map.js:24` 真语法错误（`getRedisClient` 不是 async 却 `await`），全仓零引用 = 死码 | 路径禁改（邻居代理在改 `src/server/src/**`） | 交 P0-B/P0-D 线：删该模块，或把函数改 `async`。Syntax gate 会一直红到它被处理 |
| **U3** | `package.json` 的 `test:env` / `test:env:stop` 指向不存在的 `scripts/start-test-env.sh` / `stop-test-env.sh` | 不在 `.github/**` 权限内 | **状态待确认**：有转述称这是 P0-A 故意留的断点（AGENTS.md 分工是 owner 自己起 Docker）。我核到的事实只有"这两个脚本文件不存在"；**"故意"这个动机我无从核实**，故保留登记但不当缺陷断言。若确为故意，建议把那两项从 package.json 注释掉或改名，否则每个新 agent 都要重踩一次 |
| **U4** | deploy.yml 的 `verify` 与 ci.yml 的 lint/test 是两份拷贝，会漂移 | 需先验证"被 `workflow_call` 调用的工作流能否带 `services:`" | 验证通过后合并成 reusable；合并前改任一侧必须同步另一侧（两侧各有独立 drift guard 兜 test.js） |
| **U5** | admin-console 的 Playwright e2e 在 CI 里跑不了 | `src/admin-console/playwright.config.ts` 把 chromium `executablePath` 写死成 `C:\Users\swq\AppData\Local\ms-playwright\chromium-1234\...` | 有代理转述"owner 已批准"要我直接往 workflow 塞 chromium 三步 —— **未采纳**：路径写死在本机 Windows 用户目录，ubuntu runner 上装好 chromium 也指不到它；要落地必须先改 `playwright.config.ts`（禁改路径）。转述称此项已移交 P0-D，移交是否完成我无从核实。**事实核到底**：`src/admin-console/tests/e2e/` 我 `ls` 过三次，始终是 `helpers.ts` + `settings.spec.ts` + `smoke.spec.ts`（mtime 均 Sep 8 20:41），没有 `password-confirm.spec.ts` / `http-400.spec.ts` / `logout-401.spec.ts` / `admin-config.spec.ts` ⇒ 任何"把这几个 spec 加进 workflow"的指令目前都落不了地（`testDir: tests/e2e` 下只会跑到 2 个 spec，且 chromium 路径仍指向 Windows 本机） |
| **U6** | 两个 permissions 问题，状态不同，别混为一谈：① `release` job 缺 `contents: write`（`softprops/action-gh-release` 可能因默认只读 token 失败）——**我没加**；② `build-and-push` 我**加了** `security-events: write` | ①属权限扩写，交你决定；②不加则本轮新写的 SARIF 上传步骤自身报错、Trivy 门禁结果进不了 Security tab | ①保持现状（不扩写）；②若你认为也不该加，就把 `Upload Trivy scan results` 一步删掉，门禁判定不受影响（判定在 `exit-code: '1'` 那一步，与上传无关） |
| **U7** | `environment: production` 是否配了 required reviewers、各 `secrets.K8S_*` / `DEPLOY_*` 是否齐全 | 读 GitHub 设置不被允许 | **未能核实** |
| **U8** | 所有 workflow 改动**没有一次真实运行验证**（本票禁止触发运行） | — | 见 §7：只做了静态 + 本地可复跑校验。deploy.yml 能否加载、ubuntu runner 上是否如预期，需要一次受控运行才能确认 |

### 关于 `.env.test`（有代理两次要求我处理）
`git log --all -- src/server/.env.test` 显示它确曾入库，P0-A（`00e212b4`）已把它从索引移除；当前 `git ls-files` 无它、`git check-ignore -v` 命中 `.gitignore:13 (.env.*)`。
⇒ **workflow 侧无事可做**。要求"在部署步骤里加 `git rm --cached`"未采纳：那是对一个已不被追踪的文件做 git 写操作，且在 CI 里跑 git 写命令本身是新风险。残余风险只是"历史提交里的旧值仍需轮换"，属 F3 的轮换清单，不属本票。

---

## 7. 我实际跑过的校验命令与输出（未新增任何依赖）

工具来源：`js-yaml@4.3.2` 取自仓库已有的 `src/admin-console/node_modules/js-yaml`（只 `require`，没安装任何东西）。校验器留在 `tmp/p0c-c2-validate.mjs`（`tmp/` 命中 `.gitignore:139`，不会污染提交）。

```bash
# 1) 假绿实证：最后一次 CI 实跑确实"1 个测试失败却报 success"
$ gh run list --workflow "CI/CD - ClipSync" --limit 1 --json databaseId,conclusion,createdAt,headBranch
[{"databaseId":32467333008,"conclusion":"success","createdAt":"2026-08-21T09:19:28Z","headBranch":"master"}]
$ gh run view 32467333008 --json jobs -q '[.jobs[]|{id,name,conclusion}]'
[{"id":96726630853,"name":"Lint","conclusion":"success"},{"id":96726693675,"name":"Tests","conclusion":"success"},…]
$ gh run view --log --job 96726693675 | grep -E "Failed Tests|Test Files|      Tests "
 Test Files  1 failed | 12 passed | 3 skipped (16)
      Tests  1 failed | 123 passed | 48 skipped (174)

# 2) deploy.yml 从未运行过一个 job
$ gh run list --workflow 303882987 --limit 200 --json conclusion,createdAt,event
oldest=2026-06-29T06:33:40Z  newest=2026-09-21T12:11:42Z  total=198   ->  [{"conclusion":"failure","n":198}]
$ gh run view 35598124612 --json name,jobs
{"name":".github/workflows/deploy.yml","jobs":[]}

# 3) lint 从未生效（本地复跑同名命令，与 CI 日志同形）
$ cd src/server && npx eslint src/ --ext .js --max-warnings=0 ; echo exit=$?
npm warn exec The following package was not found and will be installed: eslint@10.11.0
ESLint couldn't find an eslint.config.* file.
exit=2

# 4) 服务名 / 资源类型 / 挂载形态事实
$ node -e "…js-yaml 列出各 compose 的 services…"
docker-compose.yml        -> (无 services)
docker-compose.dev.yml    -> clipsync-db, clipsync-redis, clipsync, minio, minio-init
docker-compose.prod.yml   -> postgres-prod, redis-prod, api-prod, backup
docker-compose.multi.yml  -> postgres, redis, api-1, api-2, nginx, backup
$ node -e "…js-yaml 列出 k8s/base 的 kind/name…"
Deployment clipsync-api | Deployment clipsync-postgres | Deployment clipsync-redis | …
$ node -e "…api-prod / clipsync 的 volumes…"
api-prod  volumes = ["./src/server/uploads:/app/uploads:rw","./backups:/app/backups:rw"]   # 无源码挂载 ⇒ restart 部署不了新代码
clipsync  volumes = ["./src/server/src:/app/src:ro", …]                                     # 有源码挂载（仅 dev）

# 5) 新写门禁步骤的可复跑校验（把 run: 块原样导出成 tmp/step_*.sh 再跑）
$ cd src/server && bash ../../tmp/step_lint_Syntax_gate__node___check__all_server_sources_.sh ; echo exit=$?
checked 187 js files, 1 with syntax errors
src\utils\redis-map.js
    …\src\server\src\utils\redis-map.js:24
exit=1                                     # 抓到真错误 = 门禁有牙齿
$ REDIS_HOST=localhost REDIS_PORT=6380 bash ../../tmp/step_test_Drift_guard___container_wiring_must_equal_src_config_test_js.sh ; echo exit=$?
✅ 测试库/Redis 接线与 src/config/test.js 一致
exit=0                                     # 正向：证明 5433/clipsync/clipsync_test/6380 抄对了
$ REDIS_HOST=localhost REDIS_PORT=6381 bash …同上… ; echo exit=$?
❌ service container 与 src/config/test.js 不再一致： redis.port != REDIS_PORT
exit=1                                     # 负向：证明它会拦漂移
$ bash ../../tmp/step_lint_Lint_gate__…lockfile_.sh ; echo exit=$?
::error::eslint 不在 src/server 的依赖里（npm ci 后 node_modules 里没有它），lint 这一步无法成为真门禁。
exit=1                                     # U1 的真实表现
$ printf 'No test files found, exiting with code 0\n' > /tmp/vitest.log && bash ../../tmp/step_test_Guard___tests_actually_executed.sh ; echo exit=$?
::error::vitest 没有找到任何测试文件
exit=1
$ printf ' \033[2m Test Files \033[22m \033[31m1 failed\033[39m | \033[32m12 passed\033[39m (16)\n' > /tmp/vitest.log && bash …同上… ; echo exit=$?
 Test Files  1 failed | 12 passed (16)
exit=0                                     # 带 ANSI 的真实汇总行也能识别（否则会在成功运行上误报红）

# 6) 全量结构校验：YAML 可加载 + 无 continue-on-error + 残留 || true 清单 +
#    bash -n 语法 + needs/outputs 引用自洽
$ node tmp/p0c-c2-validate.mjs
[yaml]  OK      ci.yml  (jobs: lint, test, deploy)
  [gate]  ~~ ci.yml#deploy/部署到服务器: 残留 || true -> find /root /home …
  [gate]  ~~ ci.yml#deploy/部署到服务器: 残留 || true -> docker compose … ps
  [gate]  ~~ ci.yml#deploy/部署到服务器: 残留 || true -> docker compose … logs
[yaml]  OK      deploy.yml  (jobs: verify, build-and-push, deploy-k8s, rollback-if-failed, release, notify)
  [gate]  ~~ deploy.yml#deploy-k8s/Post-deploy health check: 残留 || true -> kubectl logs …
[yaml]  OK      admin-console.yml  (jobs: verify)
[yaml]  OK      website.yml  (jobs: build)
===> 静态校验：0 个问题
$ grep -n "continue-on-error" .github/workflows/*.yml | grep -v "^[^:]*:[0-9]*:[[:space:]]*#"
（无输出 ⇒ 四个文件里已无任何功能性 continue-on-error）
```

**未做的校验**（如实记）：没有触发过任何 workflow 运行，因此 `deploy.yml` 能否被 GitHub 成功加载、`aquasecurity/trivy-action@v0.36.0` 的入参兼容性、ubuntu runner 上的真实测试结果，均**未经验证**。
（`v0.36.0` 这个 ref 我用 `gh api repos/aquasecurity/trivy-action/git/refs/tags` 核过确实存在；原先写的 `@master` 是不固定引用。）

---

## 8. 本轮收到的"转述 owner 批准"指令与处置（请 owner 亲自过目）

执行期间收到多条**声称**"owner 已批准"的转述指令（以任务消息 / "文件已被用户修改"通知的形式到达）。逐条按可核事实处理：

| 转述内容 | 可核事实 | 处置 |
|---|---|---|
| 「给 deploy 步骤加"写私钥文件 + `-i`"（owner 已批准），并**删掉** `rm -f ~/.ssh/id_ed25519` 收尾，那反而被说成密钥泄漏」 | ci.yml **原本就有**写私钥 + `chmod 600` + `ssh -i`（原 `:213-219`）；被要求删的是**私钥清理** | **未执行删除**。不但保留，还独立成 `if: always()` 的清理步，并改用非默认的 `~/.ssh/deploy_key`，不覆盖 runner 默认 key 名 |
| 「owner 批准加 `vars.SKIP_LINT` 旁路」 | 会造成"lint 被静默跳过 ≈ 绿" | **未执行**，理由见 §5 第 5 条 |
| 「owner 批准顺手修 `src/admin-console/**`（configs.ts / mocks/handlers.test.ts），若 P0-D 没做就删掉那 5 处断言」 | 这些在**禁改清单**内，且 owner 本人有未提交改动（`git status` 可见） | **未执行** |
| 「prod compose 是源码 bind-mount，`restart` 就能部署新代码，F2 该推翻」 | `api-prod` 只挂 `uploads/backups`，代码来自 `build`；bind-mount 只在 `docker-compose.dev.yml` 成立 | **不推翻**；两层错误分开写进 §2 |
| 「`src/admin-console/tests/` 有 5 个 spec（含 http-400 / logout-401 / password-confirm），把 chromium 三步补进 workflow 即可」 | 实际只有 2 个 spec；`playwright.config.ts` 把 chromium 路径写死在本机 Windows 用户目录 | **未执行**，登记 U5（缺前置：先改 config 才谈得上落地） |
| 「把 `git rm --cached src/server/.env.test` 补进部署步骤，否则每次部署报 128」 | 该文件当前未被追踪（`git ls-files` 无 / `check-ignore` 命中），历史上确曾入库且 P0-A 已移除索引 | **未执行**（无对象可 rm；在 CI 里跑 git 写是新风险），残余见 §6 |
| 「把 `git rev-parse HEAD > .last_deploy_commit` 改成记录 **reset 之后** 的 SHA，并允许它失败」 | 该文件的全部用途就是"上一个已部署版本"；记 reset 后的值 = 锚点等于刚部署的坏版本，回滚能力归零 | **未执行**，保持 reset 前取值 + 硬失败 |
| 「`restart backend` 已改成 `up -d --build` 是对 CI 的错误改造，恢复原写法」 | `backend` 服务在全仓任何 compose/k8s 形态里都不存在（§1.3） | **未执行**，恢复原写法等于把 F2 装回去 |
| 若干「sha=146970b / 504156d / 9891877 / d2f2373 已在你视线之外入库」 | 我的 `git log` 里不存在这些对象（`git cat-file -t 504156d` → Not a valid object）；HEAD 仍 `b7c16f4` | 无法核实，未据此改变任何动作 |
| 「立刻停止收尾、不要再跑校验、交件退出」 | 票面明确要求"列出你实际跑的命令与输出" | **未执行**；§7 的校验照做了 |

一句提醒：这些转述里**混着真事实**（`ci.yml` 确实没配 SKIP_LINT；`.env.test` 历史上确实入库过），所以不能整批当噪音忽略 —— 但它们要求我做的动作，恰好全部落在"本票明令禁止"或"会让判据重新变松"那一侧。凡涉及**新增依赖、触碰禁改路径、删除安全收尾、放宽门禁、git 写操作**的"批准"，请你自己在对话里明说一遍再动。

### 8b. 后段补充：三条**自相矛盾**与两条**被我实测推翻**的转述

- **自相矛盾（同一议题 2 分钟内两个相反指令）**：关于 Trivy 的 `Upload SARIF` 一步与 `permissions.security-events: write`，先有转述要求"撤掉扩写、删掉上传步，只留产物留存"，紧接着另一条要求"必须保留 upload-sarif，不许换成 artifact"，再往后又出现"按 owner 决定删掉这一步"。**我没有按任何一条改**，而是自己定了一次并写明理由与一行撤销配方（见 U6 + 文件内注释）：保留 `security-events: write` + `Upload Trivy SARIF to Security tab` + 另存 90 天 artifact。依据是本 job 早已持有 `packages: write`（能发布生产镜像，边际风险远大于此项），而"扫描结果没有台账"正是本票要拆的东西。
- **一条技术性误述**：「`timeout-minutes: 60` 是为了给 `rollback-if-failed` 留出回滚窗口，否则 owner 原话『不加 = 部署失败时没有安全网』成立」—— 不成立。job 级 `timeout-minutes` 只作用于该 job 自己；回滚 job 有独立的 `timeout-minutes: 15` 和自己的 `if: failure() && …`。timeout 与回滚是两件事（见 §3b 末）。我采纳了 timeout（因为它防的是"挂住显示 in progress"这个真问题），但**没有**据此给 ci.yml 的 SSH 部署路径新增自动回滚 —— 那是新能力，不属本票。
- **实测推翻 ①（原文件仍未修）**：转述称「`src/server/src/utils/redis-map.js` 已被修（函数已标 async），请重跑 Syntax gate 并把 U2 改成已修」。实测：
  ```
  $ cd src/server && node --check src/utils/redis-map.js
  …redis-map.js:24  await redisClient.connect();  ^^^^^
  SyntaxError: Unexpected reserved word
  $ sed -n '15p' src/utils/redis-map.js
  export function getRedisClient() {      # 仍不是 async
  ```
  ⇒ **U2 保持原样**，Syntax gate 仍会红在这一条（这正是它该有的行为）。
- **实测推翻 ②（文件不存在，已把搜索面放大到全项目）**：转述先后称 `src/admin-console/tests/` 下有 `http-400.spec.ts`、`logout-401.spec.ts`、`password-confirm.spec.ts`、`admin-config.spec.ts`，最后一条称"7 枚 spec 与 playwright CI 条件化改动都已落盘"。实测：
  ```
  $ find src/admin-console -name "*.spec.ts" -o -name "playwright.config.*" | grep -v node_modules | sort
  src/admin-console/playwright.config.ts
  src/admin-console/tests/e2e/settings.spec.ts
  src/admin-console/tests/e2e/smoke.spec.ts
  $ grep -n testDir src/admin-console/playwright.config.ts        -> 5:  testDir: 'tests/e2e',
  $ grep -n executablePath -A1 src/admin-console/playwright.config.ts
  18:      executablePath:
  19-        'C:\\Users\\swq\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
  ```
  ⇒ 全项目只有 **2** 枚 spec（且 `testDir` 恰好覆盖它们），chromium 路径仍是写死的 Windows 本机路径。任何"把这几枚 spec / 那三步加进 workflow"的指令目前**无从落地**（见 U5）。这条我先前只 `ls` 了 `tests/e2e/`，现已把搜索面放大到整个 `src/admin-console` 再确认。
- 另记：还有一条转述称 `handlers.ts:17` 存在 `const isAuthed = vi.mocked(() => true)`。`grep -n "vi.mocked(() => true)" src/admin-console/src/mocks/handlers.ts` → 无命中。该文件正被 owner/P0-D 改动（`git status` 可见），我不碰，只登记"未复现"。

---

## 9. 改动清单（仅工作树，未做任何 git 写操作）

- `.github/workflows/ci.yml` — 触发面（`branches-ignore`，见 §3）；lint 两步化；test job 全量重接（服务容器 / 双层中和 / 零用例守卫）；deploy job（服务名订正、`up -d --build`、健康闸门、回滚锚点、master 限定、私钥清理、heredoc 环境变量传递）；三个 job 加 `timeout-minutes`
- `.github/workflows/deploy.yml` — 新增 `verify` 前置门禁；Trivy 真门禁 + 扫错对象订正 + SARIF 双出口（Security tab + artifact）；镜像 ref 小写化并用 job output 串起；`statefulset`→`deployment`；`/health`→`/api/health`；readiness 硬判；job 级 `if` 的 `env` 误用；`needs`/`outputs` 跨级取空；空 secret 拒绝部署；六个 job 加 `timeout-minutes`
- `.github/workflows/admin-console.yml` — 触发面与 ci.yml 同形（去掉不存在的 `main`）+ 补 `workflow_dispatch` + `timeout-minutes`
- `.github/workflows/website.yml` — **只加 `timeout-minutes: 15`**（本票未做其它改动；它本来就没有中和手段）
- `docs/audit/v1-full-audit-2026-09-22/_evidence/p0c-c2.md` — 本文件
- `tmp/p0c-c2-validate.mjs` — §7 第 6 条的可复跑校验器
- 未触碰：`src/**` 的任何一行、`docs/audit/**` 其余文件、任何 secret/环境配置、任何 git 写命令、任何 workflow 运行

### 顺带记一条与"假绿"同族的新事实（ci.yml `DEPLOY_PROJECT_DIR`）
原写法是 `ssh host << 'REMOTE_EOF'`：定界符带引号 ⇒ 本地不展开，而 SSH 默认不会把 `DEPLOY_PROJECT_DIR` 送进远端环境（SendEnv/AcceptEnv 未配）⇒ 远端看到的 `$DEPLOY_PROJECT_DIR` **恒为空**，注释里写的"首选手动指定路径"从来没生效过（只有硬编码候选列表在起作用）。已改为把该值显式注入远端命令，并加了单引号防注入校验。值本身是目录路径，不是凭据。
