# patches/

对 `upstream/`(tavern-study @ `16b7abda87b84a470be35db6f504e2ba88d1fdc3`「chore: 0.3.0」)的全部改动,
`git format-patch` 格式,一处一个文件,按编号顺序打。每个文件的 Subject 是改了什么,正文头两行
「为什么:」写为什么改。

| 文件 | 施工单 | 动到的上游文件 |
| --- | --- | --- |
| 001-聊天后端注入口 | 三 / 上游改动 1 | `src/chat/desk.ts` |
| 002-桌边话打标 | 四.1 / 上游改动 2 | `src/chat/desk.ts`,新增 `src/core/deskAside.ts` |
| 003-近景桌边前缀 | 四.2 / 上游改动 3 | `src/chat/deskAssemble.ts`、`src/chat/desk.ts` |
| 004-时光带滤掉桌边楼 | 四.3 / 上游改动 4 | `src/chat/deskTimeline.ts`、`src/core/deskTimelineFold.ts` |
| 005-状态板不收桌边楼 | 四.4 / 上游改动 5 | `src/chat/desk.ts`、`src/chat/deskBoardRefresh.ts` |
| 006-前端地址取origin口令首次输入 | 五 / 上游改动 6 | `frontend/app/study/page.tsx`,新增 `frontend/app/study/tokenGate.tsx` |
| 007-导出正文默认不收桌边楼 | 四.5 | `frontend/app/study/TypingDesk.tsx` |
| 008-桌边判据收紧 | 四.1 补 | `src/core/deskAside.ts`:「桌边」后面要跟冒号 / 逗号 / 空白 / 换行(或整楼只有这两个字),直接接正文的(「桌边的烛火晃了一下」)不算 |
| 009-墙纸玻璃字体与手机布局 | 10-12 她点的 | `frontend/app/globals.css`(四套墙纸变量、玻璃层、语义色收编)、`frontend/app/layout.tsx`(开机读本机设置)、新增 `frontend/app/study/deskTheme.tsx`(墙纸面板)、`frontend/app/study/page.tsx`(廊子加「墙纸」、手机底栏、写作态标记)、`frontend/app/study/TypingDesk.tsx`(窗头瘦身、⋯菜单补入口、输入区两行、楼层阅读态钩子、刘海让位变量) |

007 说明:施工单四.5 写的是 ChaptersStudio「从楼层收章节的地方」,但 16b7abd 的 ChaptersStudio
没有从楼层收章节的入口(章节是手填的),楼层变成稿子只有打字桌 ⋯ 菜单「导出正文」这一条路,
所以改在那里:默认不收桌边楼,菜单里另有「导出正文(含桌边话)」一项能收回。

## 升上游

```sh
git clone https://github.com/TricksterFlare/tavern-study && cd tavern-study
git checkout <新版本>
git am /path/to/tavern-desk/patches/*.patch      # 冲突就按 patch 头的「为什么」手动重做那一处
```

打完之后把整个仓(含 LICENSE、README、tests)拷回本仓 `upstream/`,替换旧的;再把新提交重新导出成
patches(见下),并更新 `.github/workflows/test.yml` 里钉的提交号。

## 重新导出

改 `upstream/` 的每一处都单独成一个提交,再导出(`--relative=upstream` 让路径相对上游仓根,
可直接 `git am` 到 tavern-study 上):

```sh
git format-patch -1 <提交> --relative=upstream --zero-commit --no-signature --no-encode-email-headers \
  --stdout > patches/NNN-说明.patch
```

CI(test.yml 第一步)会在 16b7abd 上依次 `git am` 这些文件,结果必须跟 `upstream/` 逐字一致。
