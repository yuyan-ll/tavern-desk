# 打字桌 · tavern-desk

基于 [tavern-study](https://github.com/TricksterFlare/tavern-study)(作者阿日 & 柒,AGPL-3.0-or-later),改动见 `patches/`。

把 tavern-study 接成一个**单机自托管**的版本:后端是一个 node 进程,数据存在本机 SQLite 文件里;
书房前端由同一个进程托管;手机上装一个安卓壳,填一次地址,之后像 app 一样用。

和上游比多了三样东西:

- **注入口**:宿主可以在每楼 system 段最前面垫自己的段,再调原来的 Anthropic 流式适配器。
- **桌边话**:开头写「桌边」两个字的那一楼(和回应它的那一楼)是场外话——照常进近景,
  但不进时光带、不进状态板,导出正文默认不收。
- **不把地址和口令编进前端包**:地址取页面自己的 origin,口令第一次打开时输一次,存在浏览器里。

## 仓库里有什么

```
upstream/        tavern-study @16b7abd 原样拷贝(LICENSE、README、tests 都在),只有 patches/ 列的几处改动
patches/         对 upstream/ 的每一处改动,一处一个 patch,头上写为什么改(见 patches/README.md)
host/            node 宿主(TypeScript,node 直接跑,不用编译,也不用 npm install)
  server.ts        入口:起 http、桥 Request/Response、托管前端、读配置
  d1shim.ts        node:sqlite 上的 D1 形状壳(上游的 D1 适配器一个字不动)
  bridge.ts        node 请求 ⇄ web Request/Response(SSE 直通不攒)
  segments.ts      注入段接口 + 假实现 FixedSegments
  backend.ts       MistletoeBackend:先垫段,再调原来的后端
  config.example.json
  tests/           宿主自己的测试
app/             安卓壳(Kotlin + WebView,Gradle 工程)
.github/workflows/
  test.yml         每次 push:patches 能重放出 upstream/、上游 npm test、host 测试、前端能编过
  android.yml      编 debug apk;push 到 main 时发 Release(tag desk-v<编号>)挂上 app-debug.apk
```

## 从零跑起来

下面的命令都在仓库根目录执行。需要一台 Linux / macOS 机器(Windows 用 WSL),装好
**Node 24**(`node --version` 看一下;`node:sqlite` 和直接跑 `.ts` 都靠它,不装任何原生包)。

### 1. 取代码

```sh
git clone https://github.com/yuyan-ll/tavern-desk.git
cd tavern-desk
```

宿主本身不需要 `npm install`。

### 2. 编前端包

```sh
cd upstream/frontend
npm ci
npm run build          # 产物在 upstream/frontend/out/,不入仓
cd ../..
```

**不要**配 `NEXT_PUBLIC_WORKER_URL` / `NEXT_PUBLIC_AUTH_TOKEN`:两个都不配,前端才会取页面自己的地址、
让你在页面里输口令。(配了就退回上游的老办法,把地址和口令编进包里。)

### 3. 写配置

```sh
cp host/config.example.json host/config.json
# 生成一个口令,填进 config.json 的 authToken
node -e "console.log(require('node:crypto').randomBytes(18).toString('base64url'))"
# API key 放进文件(只读第一行),别给别人读
printf '%s\n' 'sk-ant-你的key' > host/anthropic.key
chmod 600 host/anthropic.key host/config.json
```

`host/config.json`、`host/anthropic.key`、数据库文件都已经在 `.gitignore` 里,不会被提交。
配置里的相对路径都按 `host/` 目录算。

| 字段 | 说明 |
| --- | --- |
| `port` | 监听端口,缺省 3889。**只听 127.0.0.1**,对外怎么暴露见文末 |
| `dbPath` | SQLite 文件,缺省 `./data/desk.sqlite`(即 `host/data/desk.sqlite`),不存在就新建 |
| `apiKeyFile` | 放 Anthropic API key 的文件,只读第一行非空内容;key 不进环境变量、不打日志 |
| `anthropicBaseUrl` | 可选。Anthropic 兼容网关的**完整** Messages 端点(https),不填就是官方 |
| `authToken` | **必填**。书房口令,也是 API 路径的第一段(`/{口令}/api/oc/...`)。至少 8 位,只用字母、数字和 `. _ ~ -` |
| `ownerToken` | 可选。上游 Bearer 口令(读书角公开接口用的 owner 钥匙),不用就留空 |
| `companionToken` / `companionCommentWrite` | 可选。给家里 AI 追更的钥匙;`true` 时它能留言 |
| `allowedOrigins` | 可选。允许跨域调用的 origin 列表;不填就是书房自己的 origin(同源用不着它) |
| `defaultModel` | 可选。聊天请求没带 `model` 时用(前端总会带,主要照顾 curl);时光带折叠和状态板重算用上游固定的模型,不受它影响 |
| `segmentsModule` | 可选。注入段模块路径,见文末「宿主方还要自己做的」 |
| `fakeModel` | `true` = 试跑模式:聊天走假模型(不连网、不花钱),垫一段固定文字 |
| `frontendDir` | 可选。前端包位置,缺省 `../upstream/frontend/out` |

语义检索(上游的 Vectorize / Workers AI)这一期关闭,书架的语义搜和往事区召回会报 `capability: disabled` / 留空,其余照常。

### 4. 建库、起服务

```sh
node host/server.ts            # 或 npm start;另一份配置:node host/server.ts /path/to/config.json
```

第一次起会自动建库:新库原样执行上游的 `init.sql`,老库按 `schema_versions` 补跑 `migrations/` 里没跑过的。
看到 `[host] 打字桌在 http://127.0.0.1:3889/ 上了` 就好了。另开一个终端:

```sh
curl http://127.0.0.1:3889/health          # {"ok":true,"service":"tavern-study"}
```

浏览器打开 <http://127.0.0.1:3889/>,出现「输入口令」,填 `authToken`,进书房。
口令存在这个浏览器里,刷新即用;左侧廊子(手机上是顶部那一排,往右划)最后有「换口令」。

停服务按 Ctrl+C(或发 SIGTERM):不再接新请求,等手头正在写的楼、记账、时光带折叠干完再关库退出。

### 5. 试跑一遍(不花钱)

把 `host/config.json` 里的 `fakeModel` 改成 `true`,`apiKeyFile` 指向一个随便写了一行字的文件,重启服务。
然后用 curl 走一遍:建窗、导一个最小预设、推一楼,再推一楼桌边话。

```sh
T=你的authToken
B=http://127.0.0.1:3889/$T/api/oc/desk
id() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))"; }

P=$(curl -s -X POST "$B/import/preset?name=mini" -H 'content-type: application/json' \
  -d '{"prompts":[{"identifier":"main","name":"Main","role":"system","content":"你是一位小说家。"}]}' | id)
R=$(curl -s -X POST "$B/recipes" -H 'content-type: application/json' -d "{\"name\":\"试跑\",\"preset_id\":\"$P\"}" | id)
W=$(curl -s -X POST "$B/windows" -H 'content-type: application/json' -d "{\"project\":\"试跑\",\"recipe_id\":\"$R\"}" | id)

# 推一楼:SSE 里能看到 user_saved、text、usage、done 帧
curl -sN -X POST "$B/chat" -H 'content-type: application/json' -d "{\"window_id\":\"$W\",\"message\":\"她推开门。\"}"
# 推一楼桌边话
curl -sN -X POST "$B/chat" -H 'content-type: application/json' -d "{\"window_id\":\"$W\",\"message\":\"桌边:这段节奏是不是太快了\"}"
# 看楼层:后两楼的 report 里有 "aside": true
curl -s "$B/windows/$W"
```

(上游没有单独的 `GET /desk/floors`,楼层跟着 `GET /desk/windows/{id}` 一起回来。)

试跑完把 `fakeModel` 改回 `false`、`apiKeyFile` 指回真 key,重启。

### 6. 手机装壳

1. 先把书房用 **https** 暴露出去(见文末),手机浏览器能打开 `https://你的域名/` 再往下走。
2. 手机打开本仓的 Releases 页(<https://github.com/yuyan-ll/tavern-desk/releases>),下载最新的
   `app-debug.apk` 安装(要允许「安装未知应用」)。公开仓库的 Release 不用登录就能下;私有仓库得先登录 GitHub。
3. 第一次打开:只有一个输入框,填书房地址(比如 `https://desk.example.com`,带端口也行,不写 `https://` 会自动补),点「进书房」。
4. 进去后是书房的「输入口令」页,填 `authToken`。口令存在壳的 WebView 里,以后打开直接进。
5. **改地址:在书房里三指同时往下拉**,回到地址页。地址打不开(断网、证书不对、服务器报错)时也会自动回地址页,并写明原因。

壳里不写任何地址、也不带口令。导预设 / 世界书 / 正则 / 角色卡会弹系统的选文件;导出配方、导出正文存到手机的「下载」。
返回键:书房里能后退就后退,到头了退到后台(不关进程)。横竖屏都行。

apk 用仓库里的 `app/debug.keystore` 签名(密码 `android`,别名 `androiddebugkey`),
所以每次重编的 apk 都能直接覆盖安装,不会报「签名不符」。这把钥匙是公开的,只适合自用的 debug 包。

想自己编:装好 JDK 17+ 和 Android SDK(platform 35),`cd app && ./gradlew assembleDebug`,
产物在 `app/build/outputs/apk/debug/app-debug.apk`。

## 桌边话

在打字桌写一楼,开头是「桌边」两个字,后面跟冒号、逗号、空格或换行(或者整楼只有这两个字),这一楼就是桌边话,
直接接正文的(「桌边的烛火晃了一下」)是戏,不算;
模型回它的那一楼也算。比如:

```
桌边:这一段节奏太快了,下一楼慢一点。
```

- 楼层的 `report` 里记 `aside: true`(重 roll 也保留)。
- 照常进近景,模型知道刚才说了什么;近景里它的说话人前缀后面带「(桌边)」。
- 不进时光带:折叠时跳过,摘要里没有它们。
- 不进状态板:回楼里带了板也不采用,不补算;手动「重算状态板」也跳过桌边楼,按最近一条正常的模型楼算。
- 导出正文默认不收;⋯ 菜单里另有「导出正文(含桌边话)」。

## 升上游

见 `patches/README.md`:在上游新版本上依次 `git am patches/*.patch`,再整个拷回 `upstream/`。
CI 每次都会验证这些 patch 在钉住的上游提交上能原样重放出 `upstream/`。

## 测试

```sh
cd upstream && npm ci && npm test && cd ..     # 上游自己的测试(要 npm ci,用 wrangler 起 D1)
node --test host/tests/*.test.ts               # 宿主:D1 壳、桥、注入、桌边话(不用装依赖)
```

## License

AGPL-3.0-or-later,见 `LICENSE`;上游的 `upstream/LICENSE` 和作者署名原样保留。
书房通过网络给别人用时,按 AGPL 要给对方提供对应源码——本仓就是。

## 宿主方还要自己做的

### 写真的 `segments.home.mjs`

注入段的合同在 `host/segments.ts`:

```ts
export interface SegmentProvider {
  // 每楼生成前调一次。返回的段会原样垫在上游 system 段数组的最前面,顺序保留。
  segments(ctx: { model: string }): Promise<Array<{ text: string; cache: boolean }>>;
}
```

自己写一个 `host/segments.home.mjs`(已在 `.gitignore`,不入仓),`export default` 一个这样的对象,
再在配置里写 `"segmentsModule": "./segments.home.mjs"`。比如从同目录的文本文件里读:

```js
// host/segments.home.mjs
import { readFile } from 'node:fs/promises';

export default {
  async segments({ model }) {
    const text = await readFile(new URL('./persona.txt', import.meta.url), 'utf8');
    return [{ text, cache: false }];
  },
};
```

- 每楼都会调一次;抛错或返回的不是 `{text, cache}` 数组时,这一楼直接报错、不发、不入账(不会悄悄少垫一段)。空文字的段会被丢掉。
- 想吃到提示词缓存,段内容要逐字节稳定(别放时间戳之类)。`cache: true` 会变成一个 `cache_control` 断点,
  Anthropic 对一次请求的断点数有上限,上游自己的 system 段已经带了断点;垫的段在最前面,后面任何一个断点都会把它一起缓存,所以一般写 `cache: false` 就够。
- 只影响打字桌聊天这一条。时光带折叠和状态板重算走上游固定的 `completeText`,不垫段。
- 不做 fallback:模型被安全闸拦了(refusal)那一楼就报错、不入账,自己换模型或重 roll。

### 把 3889 暴露出去

宿主只听 `127.0.0.1:3889`。手机壳要 **https**,所以前面得有一层带证书的反向代理(或隧道)。
要求:把 `Host` 或 `X-Forwarded-Host`、`X-Forwarded-Proto` 传过来(宿主据此认出页面的 origin),
**SSE 不能缓冲**,读超时给够(一楼可能写好几分钟)。

Caddy(自动申请证书,自带转发头):

```
desk.example.com {
    reverse_proxy 127.0.0.1:3889 {
        flush_interval -1
    }
}
```

nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3889;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_buffering off;
    proxy_read_timeout 600s;
    client_max_body_size 12m;
}
```

也可以用 Cloudflare Tunnel、Tailscale Funnel 这类隧道,同样要关缓冲。
口令是 URL 的第一段路径:**别在反代上开会记录完整 URL 的访问日志**,或者把那一段打码。

### 常驻

systemd 例子(路径、用户按自己的改):

```ini
# /etc/systemd/system/tavern-desk.service
[Unit]
Description=打字桌
After=network-online.target
Wants=network-online.target

[Service]
User=desk
WorkingDirectory=/opt/tavern-desk
ExecStart=/usr/bin/node host/server.ts
Restart=on-failure
KillSignal=SIGTERM
# 停服务时会等正在写的楼写完,给足时间
TimeoutStopSec=600

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now tavern-desk
journalctl -u tavern-desk -f
```

升级:`git pull`,前端有变就重新 `npm run build`,然后 `systemctl restart tavern-desk`。

### 备份

数据全在 `dbPath` 那一个 SQLite 文件里(WAL 模式,旁边会有 `-wal` / `-shm`)。服务开着也能安全地拷一份一致的快照:

```sh
mkdir -p /backup
node -e "new (require('node:sqlite').DatabaseSync)('host/data/desk.sqlite').exec(\"VACUUM INTO '/backup/desk-$(date +%F).sqlite'\")"
```

放进 cron 每天跑一次,定期把 `/backup` 拷到别的机器。还原:停服务,删掉旧的 `desk.sqlite`、`-wal`、`-shm`,
把备份拷成 `desk.sqlite`,再起服务。

另外三个不在仓库里的文件也要一起备份:`host/config.json`、API key 文件、`host/segments.home.mjs`。
