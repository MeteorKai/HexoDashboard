# Hexo Tool · Hexo 写作台

一个运行在本机浏览器中的 Hexo 写作与发布工具。直接管理现有博客的 Markdown 文件，把文章编辑、图片插入、本地生成、预览和部署放在同一个界面里。

不需要数据库，也不需要为本工具执行 `npm install`：服务端使用 Node.js 内置模块，页面与第三方库随源码提供。

## 功能

- **文章与草稿**：新建、编辑、搜索、重命名、草稿发表，以及批量移入回收站。
- **文章属性**：编辑标题、日期、分类、标签和 MathJax 开关；保留未修改的 Front-matter 字段和注释。
- **专注写作**：独立编辑页、按需打开的实时预览标签页、字数统计、浅色和深色主题。
- **图片管理**：选择文件、粘贴或拖拽插图，使用 Hexo 的 `asset_img` 标签，支持图片归档与恢复。
- **历史与恢复**：保存前备份历史版本；删除文章时连同图片移入回收站，可恢复。
- **PDF 导入**：将可提取文字的 PDF 转成 Markdown；不包含 OCR，扫描件需要先识别文字。
- **生成与部署**：执行 Hexo 的生成、清理、预览、部署命令，在页面查看实时任务日志并中止任务。
- **网页设置与配置编辑**：首次启动即可在网页设置博客目录；原文编辑博客 YAML 配置，校验语法、检查版本冲突并自动备份。
- **无窗口启动**：Windows 支持 VBS 隐藏启动；在网页关闭服务后，后台与隐藏启动器一起退出。

## 环境要求

- [Node.js](https://nodejs.org/en/download)：建议使用 24 LTS；当前测试环境为 `24.13.1`。[版本状态](https://nodejs.org/en/about/previous-releases)
- 一个已初始化的 Hexo 博客，至少包含 `_config.yml` 和 `source/_posts/`。
- 若要生成、预览或部署，请先在**博客目录**安装 Hexo 及相应插件；本工具优先使用博客的本地 Hexo 命令，再尝试全局 `hexo`。
- 部署到 Git 仓库时，需要博客的部署插件、Git 和你自己的访问凭据。部署配置继续使用博客的 `_config.yml`。[Hexo 命令文档](https://hexo.io/docs/commands)

Windows 启动器已通过自动化测试。macOS 提供 `.command` 启动脚本；其他平台可以使用下文的 Node.js 命令。macOS/Linux 尚未在当前环境做运行验证。

源码仓库不附带 Node.js 二进制文件。便携包可自行在 `node/` 放置对应平台的运行时，但该目录不会提交到 Git。

## 快速开始

下载源码，或克隆你部署的仓库，然后进入 `hexo-tool` 目录。

### Windows

直接双击 `启动写作台.vbs`，无需在终端输入博客路径。也可从 PowerShell 启动：

```powershell
wscript.exe ".\启动写作台.vbs"
```

服务就绪后会自动打开浏览器。首次使用时会自动打开「设置」：填写你的 Hexo 博客目录，点击「保存设置」，即可开始使用。路径会记住，后续启动无需重复填写；失效的旧路径也可在网页重新设置。

- `启动写作台.vbs`：不显示终端窗口，需要与同名 BAT 保持在同一目录。
- `启动写作台.bat`：会交给 VBS 隐藏运行，但 Windows 启动 BAT 时仍可能短暂闪窗。
- 两种入口都优先使用 PATH 中的 Node.js；找不到时才尝试 `node/node.exe`。
- 启动失败时会弹出错误提示，可查看 `data/launcher.log`。

### macOS

安装本机 Node.js 后，在项目目录运行：

```bash
chmod +x 启动写作台.command
./启动写作台.command
```

也可以直接双击 `.command`，博客路径统一在网页「设置」中填写。这个入口会使用终端。

### 直接使用 Node.js（Windows / macOS / Linux）

```bash
node src/server.js
```

然后打开 [http://127.0.0.1:4321](http://127.0.0.1:4321)，在网页「设置」中选择博客目录。Windows/macOS 可添加 `--open` 在服务就绪后自动打开浏览器。命令行博客参数与 `HEXO_BLOG` 环境变量仍可作为可选覆盖。

### 关闭服务

在网页右上角点击「关闭服务」，再次点击确认。本地预览也会停止；Windows 的隐藏后台进程会自动结束，不需要打开终端关闭。

直接关掉浏览器标签页**不会**停止服务。普通标签页可能不允许脚本关闭自身，此时会显示「写作台已关闭」，可以手动关闭标签页。

## 配置

通过网页「设置」保存配置，文件位于 `data/.hexo-tool-settings.json`，首次保存时自动生成。无需手动创建。

| 配置项 | 默认值 / 说明 |
| --- | --- |
| 博客目录 | 首次使用在网页中填写，保存后立即生效；后续自动读取 |
| 写作台端口 | `4321`，修改后需要关闭并重新启动服务 |
| 本地预览端口 | `4000`，不能与写作台端口相同 |

博客路径的优先级为：命令行参数 → `HEXO_BLOG` 环境变量 → 已保存设置。写作台端口的优先级为：`PORT` 环境变量 → 已保存设置 → `4321`。

例如在 PowerShell 中临时换一个端口：

```powershell
$env:PORT = "4322"
wscript.exe ".\启动写作台.vbs"
```

macOS/Linux 的等价启动方式：

```bash
PORT=4322 node src/server.js
```

图片功能需要博客启用 `post_asset_folder: true`。发布前确认 `render_drafts` 和 `deploy` 配置符合预期；工具会在包含草稿的部署操作前要求明确确认。[Hexo 配置文档](https://hexo.io/docs/configuration)

### 编辑博客 YAML 配置

设置博客目录后，再打开「设置」，展开「博客配置文件（YAML）」：

1. 选择要修改的文件，例如 `_config.yml`、`_config.butterfly.yml` 或 `config.yaml`。
2. 在文本框中修改原文，点击「保存配置文件」（与「保存设置」是两个独立操作）。
3. 保存后重新生成站点；如果本地预览正在运行，需要先停止预览，保存配置后再启动。

仅支持博客**根目录中已存在的** `config` / `_config` 系列 `.yml`、`.yaml` 文件，不会创建新文件，也不直接编辑主题子目录。Hexo 博客仍须有标准的 `_config.yml`；其他 YAML 文件是否参与构建取决于你的主题和 Hexo 配置。

保存前校验 YAML 对象格式，单个文件最大 1MB；保留原文注释及原文件的换行和 BOM。旧内容自动备份到博客的 `.hexo-tool-history/configs/`。如果文件在外部被修改，或博客目录已切换，会拒绝覆盖；请先保留自己的编辑内容，再点击「重新读取」。关闭编辑窗口、切换配置文件或刷新时，有未保存的修改会提示确认。

## 数据存放位置

| 位置 | 内容 |
| --- | --- |
| 博客的 `source/_posts/`、`source/_drafts/` | 正式文章、草稿与同名图片资源目录 |
| 博客的 `.hexo-tool-history/` | 文章历史版本、归档图片、YAML 配置备份 |
| 博客的 `.hexo-tool-trash/` | 删除文章与其图片的回收站 |
| 本工具的 `data/` | 本地设置、启动日志、PID 与上次部署记录 |
| 浏览器 `localStorage` | 未保存编辑内容的恢复缓存、界面偏好 |

历史记录和回收站不是备份策略的替代品；重要文章仍建议使用 Git 或其他备份方式管理。发布本工具源码时不要上传本地配置、日志或博客内容。

## 项目结构

```text
hexo-tool/
├── src/                 # HTTP API、Hexo 任务、文件与历史管理、PDF 转换
├── web/                 # 写作台、独立编辑页、预览页与样式
├── vendor/              # 随源码提供的第三方库及许可证
├── tests/               # 单元测试、接口与界面回归测试
├── tools/               # 图标生成工具
├── 启动写作台.vbs       # Windows 无窗口入口
├── 启动写作台.bat       # Windows 启动逻辑
├── 启动写作台.command   # macOS 启动入口
├── Hexo写作台.ico
├── .gitattributes        # 保持不同平台启动脚本的正确换行
├── .gitignore
├── LICENSE
├── NOTICE
└── README.md
```

运行时自动创建的 `data/`、可选的 `node/`、开发产物 `.workbuddy/` 和测试报告均已被 `.gitignore` 排除。

## 开发与测试

在项目根目录运行以下命令，无需安装额外测试依赖：

```bash
node --test tests/lib.test.js tests/pdfmd.test.js tests/launchers.test.js tests/settings.test.js
node tests/static-check.js
node tests/buffer-check.js
node tests/contrast-audit.js
node tests/e2e.js
```

单元测试和接口测试使用临时博客，不会对你的真实博客执行部署。Windows 启动器测试仅在 Windows 运行；macOS 启动脚本测试需要 Bash，Windows 上可通过 `BASH_EXE` 指定 Git Bash。

可选测试：

- Windows 设置页回归：PowerShell 中执行 `$env:HEXO_UI_TEST='1'; node --test tests/settings.test.js; Remove-Item Env:HEXO_UI_TEST`。需要默认路径安装的 Chrome/Edge；覆盖首次设置博客、编辑 YAML、错误校验和冲突提示。
- `node tests/ui-style.test.js`：使用 Chrome/Edge 的无头模式做页面回归；当前浏览器查找逻辑针对 Windows 默认安装路径。
- `node tests/hexo-run.js "/path/to/your/hexo-blog"`：借用已有博客的 Hexo 依赖与主题，在临时目录验证真实生成和预览。
- `tests/ui-blog-setup.js`、`tests/shot-pdf.js`：用于准备临时界面测试博客和验证 PDF 导入；仅对专用测试实例运行界面验收脚本。
- `node tools/make-icon.js`：重新生成应用图标，预览图输出到 `.workbuddy/`。

提交改动前请运行适用测试，并保留 `vendor/` 中的版权声明和许可证。生成的测试报告、截图和个人配置不要提交。

## 使用边界

写作台只监听 `127.0.0.1`，用于本机单用户工作，不是提供公网访问的多用户管理后台。它会修改指定博客的文件，并以当前用户权限执行 Hexo 及其插件；请使用你信任的博客与依赖。

PDF 转换在本机完成，不上传到外部转换服务；复杂排版的还原结果仍需要人工校对。生成、部署等 Hexo 插件操作以及正文中的外部图片，可能按你自己的配置访问网络。

## 许可证与第三方组件

本项目原创代码采用 [Apache License 2.0](LICENSE)，完整文本见 `LICENSE`，版权与第三方说明见 `NOTICE`。[Apache 官方许可证](https://www.apache.org/licenses/LICENSE-2.0)

`vendor/` 中的组件继续遵循各自许可证：

| 组件 | 用途 | 许可证文件 |
| --- | --- | --- |
| Marked | Markdown 预览 | `vendor/marked-LICENSE.md`（MIT） |
| DOMPurify | 预览 HTML 清洗 | `vendor/dompurify-LICENSE`（随包保留 Apache-2.0 文本；库声明为 Apache-2.0 / MPL-2.0 双许可） |
| js-yaml | YAML 与 Front-matter 解析 | `vendor/js-yaml-LICENSE`（MIT） |
| PDF.js | PDF 文字与版式提取 | `vendor/pdfjs/LICENSE`（Apache-2.0） |

不要删除第三方许可证、PDF.js worker、CMap 或字体资源；它们不是多余文件。
