# 打字桌 · 云上施工单

这份单子是给云会话(Claude Code cloud session)的,自包含,不带家里的任何东西。读完照做,做完按「验收」自检,交付物列在最后。

## 要做什么

把开源仓 tavern-study(https://github.com/TricksterFlare/tavern-study ,AGPL-3.0-or-later,作者阿日 & 柒,以 commit `16b7abda87b84a470be35db6f504e2ba88d1fdc3`「chore: 0.3.0」为准)接成一个**单机自托管**的版本:

1. 后端从 Cloudflare Worker 改成一个 node 进程(node 24,`node:sqlite` 内建,不装原生包),数据库从 D1 换成本机 SQLite 文件。
2. 模型通道留一个注入口:宿主可以在每楼的 system 段前面垫自己的段,再调原来的 Anthropic 流式适配器。
3. 加「桌边话」:楼开头是「桌边」两个字的那一楼不进时光带、不进状态板、不收章节。
4. 前端(Next.js 静态导出)改成不把地址和口令编译进包里:地址取页面自己的 origin,口令第一次打开时输入一次存在浏览器里。
5. 一个安卓壳(Kotlin + WebView),第一次打开填地址,之后像 app 一样用;GitHub Actions 自动编 apk 挂到 Release。

上游代码的改动越少越好,每一处都要能用一个 patch 文件说清楚,方便以后升上游。

## 仓库布局

```
upstream/        tavern-study 原样拷贝(整个仓,含 LICENSE、README、tests)。不动它的文件,除了下面「上游改动」列出的几处
patches/         对 upstream 的每一处改动,git format-patch 风格,一处一个文件,文件头写为什么改
host/            node 宿主(TypeScript,node 直接跑,不用 tsc 编译)
  server.ts        入口:起 http、桥 Request/Response、托管静态前端、读配置
  d1shim.ts        node:sqlite 上的 D1 形状壳
  bridge.ts        node IncomingMessage ⇄ web Request/Response
  segments.ts      注入段的接口 + 一份假实现(真实现宿主方自己接)
  backend.ts       包装 AnthropicStreamBackend:先垫 segments,再调原来的
  config.example.json
app/             安卓壳(Gradle 工程)
.github/workflows/
  test.yml         push 时跑 upstream 的 npm test + host 的测试
  android.yml      push 到 main 时编 debug apk,传 artifact,并发一个 Release(tag = desk-v<run_number>)挂上 apk
README.md        怎么在自己机器上跑起来(配置、建库、起服务、前端包、手机装壳),中文
```

## 一、D1 形状的壳(host/d1shim.ts)

上游 **12 个文件**直接拿 `env.OC_DB` 当 D1 用(`examples/cloudflare/index.ts`、`src/chat/desk.ts`、`src/chat/deskAssemble.ts`、`src/chat/deskBoardRefresh.ts`、`src/chat/deskTimeline.ts`、`src/storage/usageSink.ts`、`src/tools/desk.ts / deskPanels.ts / deskRecipes.ts / deskWindows.ts / reading.ts / study.ts`),加 `examples/cloudflare/adapters/` 六个适配器。所以**不重写适配器,写一层壳让 `node:sqlite` 长得像 D1**,这些文件一个字不动。

上游用到的 D1 面(数过):`prepare(sql)`、`.bind(...values)`(返回新语句,原语句不变)、`.all()` → `{ results: 行数组, success: true, meta: { changes, last_row_id } }`、`.first()` → 行或 `null`(带列名参数时返回那一列的值)、`.run()` → `{ success: true, meta: { changes, last_row_id } }`、`db.batch([语句...])` → 结果数组(**整批在一个事务里**,任一失败整批回滚并抛错)、`db.exec(sql)`(多条语句,返回 `{ count }`)。上游读的 meta 字段只有 `meta.changes`,`success` 只读一处。

绑定值要处理:`undefined` → `null`,布尔 → 0/1,`?1 ?2` 这种带号的占位符 SQLite 原生支持,直接透传。

建库:把 `examples/cloudflare/schema/init.sql` 原样 `exec`,再按 `schema/migrations/` 顺序跑没跑过的(`schema_versions` 表记着)。

验收:把 `upstream/tests/d1DeskAdapters.test.ts` 复制一份改成跑在壳上(只换数据库来源),全绿。

## 二、桥和宿主入口(host/bridge.ts、host/server.ts)

- `examples/cloudflare/index.ts` 导出的 `handle(request, env, ctx)` 整个复用,路由表一条不改。
- 桥:node 的 `IncomingMessage` 转成全局 `Request`(方法、头、body 流),`Response` 写回 `ServerResponse`(状态、头、body 用 `Readable.fromWeb` pipe,SSE 不能缓冲)。`ctx.waitUntil(p)` 把 Promise 收进一个数组,进程退出前 `await` 完。
- `env` 对象:`OC_DB`(壳)、`ANTHROPIC_API_KEY`(从配置里指的文件读一行,**不进环境变量、不打日志**)、`ANTHROPIC_BASE_URL`(可选)、`AUTH_TOKEN`、`OWNER_TOKEN`、`COMPANION_TOKEN`(可选)、`ALLOWED_ORIGINS`、`COMPANION_COMMENT_WRITE`、`DESK_BACKEND`(见三)。`OC_VECTORIZE` 和 `AI` 不给:语义检索这一期关闭,上游自己会报 `capability: disabled`。
- 静态前端:`frontend/out/` 托管在 `/`(`/_next/...` 等绝对路径照常),API 照上游在 `/{AUTH_TOKEN}/api/oc/...`。`ALLOWED_ORIGINS` 默认就是自己的 origin。
- 只监听 `127.0.0.1`,端口来自配置(默认 3889)。对外怎么暴露是宿主方的事,单子里不管。
- 配置文件 `host/config.json`(gitignore 掉,给 `config.example.json`):`port`、`dbPath`、`apiKeyFile`、`authToken`、`ownerToken`、`allowedOrigins`、`defaultModel`。

## 三、模型通道的注入口(上游改动 1 + host/backend.ts、host/segments.ts)

- 上游 `src/chat/desk.ts` 第 413 行附近 `const backend = new AnthropicStreamBackend({...})` 改成 `const backend = env.DESK_BACKEND ?? new AnthropicStreamBackend({...})`,`env` 的类型上加可选的 `DESK_BACKEND?: ModelBackend`。这是**对上游唯一一处为注入口做的改动**。
- `host/segments.ts` 定义接口:

```ts
export interface SegmentProvider {
  // 每楼生成前调一次。返回的段会原样垫在上游 system 段数组的最前面,顺序保留。
  segments(ctx: { model: string }): Promise<Array<{ text: string; cache: boolean }>>;
}
```

  自带一份 `FixedSegments`(给定几段固定文字)当假实现,测试和本机试跑用它;真实现由宿主方另写,通过配置里一个模块路径加载(`segmentsModule: "./segments.home.mjs"`,export default 一个 SegmentProvider)。
- `host/backend.ts`:`MistletoeBackend(inner: ModelBackend, provider: SegmentProvider)`,`streamChat(args)` = `inner.streamChat({ ...args, system: [...await provider.segments({ model: args.model }), ...args.system] })`。其余(thinkingTags、signal、onEvent)原样透传。
- 时光带折叠和状态板重算走上游固定的 `completeText`(`src/chat/modelBackend.ts`),**不垫段**,不改。
- 不开 API 的 `fallbacks`(被安全闸停了就是停了,那一楼报错、不入账,用户自己重 roll)。上游已经把 `refusal` 单列成失败,保持。

验收:用 `FakeModelBackend` 包一层 `MistletoeBackend`,断言真正收到的 `system[0..n]` 是垫的段、后面接着上游拼的段、`cache` 标记原样。

## 四、桌边话(上游改动 2–5)

定义:用户那一楼的正文去掉首尾空白后,**以「桌边」两个字开头**(后面可以跟换行、冒号、空格或直接正文),这一楼就是桌边话。回应它的那一楼也算桌边话。在楼层的 `report` 字段里记 `aside: true`(`report` 是现成的自由 JSON 列,不加表字段)。

四处改动,各几行:

1. `src/chat/desk.ts`:存用户楼时判断并打标;提交模型回楼时,若本轮用户楼是桌边话,回楼的 `report.aside = true`。
2. `src/chat/deskAssemble.ts`:近景楼层照常带上桌边楼(模型得知道刚才说了什么),说话人前缀后面加「(桌边)」。
3. `src/chat/deskTimeline.ts` 和 `src/core/deskTimelineFold.ts`:选折叠批次前先把桌边楼滤掉;折叠正文也不含它们;游标照常前进(桌边楼算「已处理」,只是不进摘要)。
4. `src/chat/desk.ts` 的状态板自动补算:本轮是桌边话时跳过;`deskBoardRefresh` 手动重算时忽略桌边楼的正文。
5. 前端 `ChaptersStudio` 从楼层收章节的地方:桌边楼默认不勾(能手动勾回)。

验收:新测试文件覆盖 1–4(用内存存储 + FakeModelBackend):一段三楼正常、两楼桌边、再三楼正常的窗,折叠批次只含六楼正常的,摘要正文里没有桌边字样,近景里有「(桌边)」前缀,板没被桌边楼改。

## 五、前端(上游改动 6)

`frontend/app/study/page.tsx` 第 203–206 行现在从 `NEXT_PUBLIC_WORKER_URL` / `NEXT_PUBLIC_AUTH_TOKEN` 拼 `base`,编译时写死。改成:

- 两个环境变量都没有时(咱们的构建就是这样),挂载后取 `window.location.origin` 当 workerUrl;口令从 `localStorage['tavern-desk.token']` 读,没有就显示一个只有一个输入框的页面「输入口令」,填了存起来、刷新即用;页面某处(设置抽屉或页脚)给一个「换口令」把它清掉。
- 静态导出下首屏是预渲染的,`window` 不存在,所以 base 要放进 state、在 `useEffect` 里算,算出来之前照原来 `envOk=false` 的分支显示等待。
- 两个环境变量还在的时候行为跟上游完全一样(别破坏他家自己的部署方式)。

构建:`cd upstream/frontend && npm ci && npm run build`(`next build --webpack`,`output: 'export'`),产物 `out/` 不入仓,由 `test.yml` 顺手验证能编过。

## 六、安卓壳(app/)

- Kotlin,单 Activity + WebView,minSdk 29,targetSdk 35。应用名「打字桌」,包名 `app.tavern.desk`。
- **第一次打开**:一个只有一个输入框的页面,填书房地址(https,带端口也行),存 `SharedPreferences`;以后直接进 WebView。WebView 页面里长按标题栏区域(或三指下拉,任选一种,README 写明)回到地址页改地址。地址打不开时自动回地址页并显示原因。
- WebView:JavaScript、DOM storage、`localStorage` 持久(口令就存在这儿)、`mixedContentMode` 不开、`userAgent` 保留并追加 ` TavernDesk/1.0`。
- **选文件**:`WebChromeClient.onShowFileChooser` 接 `ACTION_GET_CONTENT`(多选、任意类型),书房导预设 / 世界书 / 正则 / 角色卡全靠它,这一条是必须的。
- **下载**:`setDownloadListener` 接 `DownloadManager`,存到系统「下载」,导出配方的 JSON 走这条。
- **铺满**:edge-to-edge,系统栏沉浸(`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`),内容画进刘海区。
- **键盘让位**:`setDecorFitsSystemWindows(false)` + `OnApplyWindowInsetsListener` 把 IME 高度作为底部 padding 给 WebView,打字时输入框不被盖住。
- **返回键**:WebView 能后退就后退,到头了 `moveTaskToBack(true)` 不关进程。
- 横竖屏都支持,配置变化不重建 WebView(`configChanges`)。
- 签名:`app/debug.keystore` **入仓**(密码 `android`,alias `androiddebugkey`,README 写明),`android.yml` 用它签,这样每次重编的 apk 能覆盖安装不报签名不符。
- `android.yml`:`ubuntu-latest`(自带 Android SDK),`./gradlew assembleDebug`,产物上传 artifact,并用 `softprops/action-gh-release` 发 Release `desk-v${{ github.run_number }}` 挂上 `app-debug.apk`(public 仓的 Release 资产不用登录就能从手机下载)。
- 壳里**不写任何地址**,也不带口令;口令在页面里输,存在 WebView 的 localStorage。

## 七、规矩

- 上游文件只在「上游改动 1–6」列的地方动,每处一个 `patches/NNN-说明.patch`,patch 头两行写为什么。别重排格式、别顺手改别的。
- `upstream/LICENSE` 和作者署名原样保留。本仓根目录放一份 `LICENSE`(AGPL-3.0-or-later)和一句「基于 tavern-study,改动见 patches/」。
- 代码和注释用中文,跟上游一致。
- 不要编造使用者的信息;配置里没有的东西就留空或给 example。
- 密钥只从文件读,不进日志、不进环境变量、不进仓库;`.gitignore` 挡住 `host/config.json`、`*.sqlite*`、`frontend/out/`、`host/segments.home.mjs`。
- `npm test`(upstream)必须一直绿;host 自己的测试跑 `node --test host/tests/*.test.ts`。

## 验收

1. `cd upstream && npm ci && npm test` 全绿。
2. `node --test host/tests/*.test.ts` 全绿(壳、桥、注入、桌边话)。
3. 本机起宿主(`node host/server.ts`,配置用 example 加一个假 key 文件),用 `FixedSegments` + `FakeModelBackend` 的试跑模式(配置项 `fakeModel: true`):`curl` 建窗、导一个最小预设、推一楼,SSE 里能看到 text 和 done 帧;再推一楼开头写「桌边」,`GET /desk/floors` 能看到 `report.aside = true`。
4. `frontend` 能 `npm run build`,打开 `/` 出现口令输入页,填口令后进书房。
5. `android.yml` 在 GitHub Actions 上跑通,Release 里有 `app-debug.apk`;`test.yml` 绿。
6. README 从零到跑起来的步骤一个人照着能走通。

## 交付

- 仓库本身(上面的布局)。
- `patches/` 六个文件。
- Release 里的 apk。
- README 末尾一节「宿主方还要自己做的」:写真的 `segments.home.mjs`、把 3889 暴露出去、常驻和备份。
