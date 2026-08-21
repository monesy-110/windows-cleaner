import { createServer } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readdir, lstat, readFile, rmdir, rm, statfs, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const port = Number(process.env.PORT ?? 4280);
const host = "127.0.0.1";
const scanEntryLimit = 25000;
const scanTimeLimitMs = 8000;
const recentFileWindowMs = 24 * 60 * 60 * 1000;
const scanTicketLifetimeMs = 15 * 60 * 1000;
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const roamingAppData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
const programData = process.env.ProgramData ?? "C:\\ProgramData";
const windowsDirectory = process.env.SystemRoot ?? "C:\\Windows";
const userProfile = process.env.USERPROFILE ?? homedir();
const scanTickets = new Map();

const staticFiles = new Map([
  ["/", { file: "public/index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "public/styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "public/app.js", type: "text/javascript; charset=utf-8" }],
  ["/app-icon.png", { file: "public/app-icon.png", type: "image/png", cache: true }],
  ["/app-icon-light.png", { file: "public/app-icon-light.png", type: "image/png", cache: true }],
  ["/app-icon.ico", { file: "public/app-icon.ico", type: "image/x-icon", cache: true }],
  ["/app-icon-light.ico", { file: "public/app-icon-light.ico", type: "image/x-icon", cache: true }],
  ["/vendor/phosphor/style.css", { file: "node_modules/@phosphor-icons/web/src/regular/style.css", type: "text/css; charset=utf-8", cache: true }],
  ["/vendor/phosphor/Phosphor.woff2", { file: "node_modules/@phosphor-icons/web/src/regular/Phosphor.woff2", type: "font/woff2", cache: true }],
]);

const groupLabels = {
  system: "Windows 与临时数据",
  diagnostics: "诊断与崩溃材料",
  graphics: "图形缓存",
  browser: "浏览器缓存",
  apps: "通讯与桌面应用",
  development: "开发工具缓存",
  gaming: "游戏缓存",
  drive: "所选磁盘",
};

const definitions = [
  {
    id: "user-temp", group: "system", scope: "system", name: "当前用户临时文件",
    detail: "安装器残留、会话临时文件与应用临时数据。",
    impact: "应用会按需重建缓存；正在运行的程序可能暂时保留部分文件。",
    roots: () => [tmpdir()], risk: "safe", defaultChecked: true, preserveRecent: true,
  },
  {
    id: "windows-temp", group: "system", scope: "system", name: "Windows 临时目录",
    detail: "系统组件和安装服务留下的临时工作文件。",
    impact: "不会删除系统组件；受保护或占用中的文件会被保留。",
    roots: () => [join(windowsDirectory, "Temp")], risk: "review", defaultChecked: false, preserveRecent: true,
  },
  {
    id: "wer-reports", group: "diagnostics", scope: "system", name: "Windows 错误报告",
    detail: "系统排队等待发送的崩溃诊断报告与附件。",
    impact: "会失去这些旧故障的诊断材料，不影响程序日常运行。",
    roots: () => [
      join(localAppData, "Microsoft", "Windows", "WER", "ReportArchive"),
      join(localAppData, "Microsoft", "Windows", "WER", "ReportQueue"),
      join(programData, "Microsoft", "Windows", "WER", "ReportArchive"),
      join(programData, "Microsoft", "Windows", "WER", "ReportQueue"),
    ],
    risk: "review", defaultChecked: false, preserveRecent: true,
  },
  {
    id: "crash-dumps", group: "diagnostics", scope: "system", name: "应用崩溃转储",
    detail: "应用异常退出后生成的 DMP 调试文件。",
    impact: "会失去开发者排查旧崩溃所需的内存转储，不影响应用启动。",
    roots: () => [join(localAppData, "CrashDumps")], risk: "review", defaultChecked: false, preserveRecent: true,
  },
  {
    id: "kernel-dumps", group: "diagnostics", scope: "system", name: "Windows 内核故障转储",
    detail: "蓝屏与硬件驱动故障留下的小型转储和实时内核报告。",
    impact: "会失去旧蓝屏或驱动故障的诊断证据；最近 24 小时报告自动保留。",
    roots: () => [join(windowsDirectory, "Minidump"), join(windowsDirectory, "LiveKernelReports")],
    risk: "review", defaultChecked: false, preserveRecent: true,
  },
  {
    id: "shader-cache", group: "graphics", scope: "system", name: "DirectX 着色器缓存",
    detail: "显卡驱动和图形程序保存的已编译着色器。",
    impact: "游戏或图形程序首次启动可能短暂重新编译，之后恢复正常。",
    roots: () => [join(localAppData, "D3DSCache")], risk: "safe", defaultChecked: true, preserveRecent: false,
  },
  {
    id: "vendor-shader-cache", group: "graphics", scope: "system", name: "显卡厂商着色器缓存",
    detail: "NVIDIA、AMD 与 Intel 驱动生成的 DX、OpenGL 和图形管线缓存。",
    impact: "不会删除驱动或游戏存档；图形程序首次运行可能出现短暂编译卡顿。",
    roots: () => [
      join(localAppData, "NVIDIA", "DXCache"), join(localAppData, "NVIDIA", "GLCache"),
      join(localAppData, "AMD", "DxCache"), join(localAppData, "AMD", "GLCache"),
      join(localAppData, "Intel", "ShaderCache"), join(programData, "NVIDIA Corporation", "NV_Cache"),
    ],
    risk: "review", defaultChecked: false, preserveRecent: true,
  },
  {
    id: "thumbnails", group: "system", scope: "system", name: "资源管理器缩略图缓存",
    detail: "图片和视频预览使用的缩略图数据库。",
    impact: "文件不会受影响；首次打开大型图片目录时预览会重新生成。",
    roots: () => [join(localAppData, "Microsoft", "Windows", "Explorer")],
    include: (name) => /^thumbcache.*\.db$/i.test(name), risk: "safe", defaultChecked: true, preserveRecent: false,
  },
  {
    id: "delivery-cache", group: "system", scope: "system", name: "传递优化缓存",
    detail: "Windows 更新在设备间分发时保存的下载片段。",
    impact: "必要时 Windows 会重新下载；更新服务运行时本项会锁定。",
    roots: () => [join(windowsDirectory, "SoftwareDistribution", "DeliveryOptimization")],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["wuauserv"], blockerType: "service",
  },
  {
    id: "windows-update-download", group: "system", scope: "system", name: "Windows 更新下载缓存",
    detail: "Windows Update 已下载但可重新取得的安装片段。",
    impact: "不会卸载已安装更新；更新服务下次需要时可能重新下载，清理期间会跳过正在使用的文件。",
    roots: () => [join(windowsDirectory, "SoftwareDistribution", "Download")],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["wuauserv", "bits"], blockerType: "service",
  },
  {
    id: "font-cache", group: "system", scope: "system", name: "Windows 字体缓存",
    detail: "系统字体服务生成的可重建字体索引缓存。",
    impact: "不会删除字体文件；字体服务会重建索引，首次打开字体密集型应用可能稍慢。",
    roots: () => [join(windowsDirectory, "ServiceProfiles", "LocalService", "AppData", "Local", "FontCache")],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["FontCache"], blockerType: "service",
  },
  {
    id: "store-local-cache", group: "apps", scope: "system", name: "Microsoft Store 本地缓存",
    detail: "仅清理已安装 Store 应用明确标记为 LocalCache 的临时内容。",
    impact: "不会删除账号、应用设置或已安装应用；个别应用首次启动可能重新下载资源。",
    roots: () => microsoftStoreCaches(),
    risk: "review", defaultChecked: false, preserveRecent: true,
  },
  {
    id: "chrome-cache", group: "browser", scope: "system", name: "Chrome 网页缓存",
    detail: "所有 Chrome 配置文件的网页资源与代码缓存。",
    impact: "书签、密码、Cookie 和下载不受影响；网页首次打开会重新下载资源。",
    roots: () => chromiumProfileCaches(join(localAppData, "Google", "Chrome", "User Data")),
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["chrome"], blockerType: "process",
  },
  {
    id: "edge-cache", group: "browser", scope: "system", name: "Edge 网页缓存",
    detail: "所有 Edge 配置文件的网页资源与代码缓存。",
    impact: "收藏夹、密码、Cookie 和下载不受影响；网页首次打开会重新下载资源。",
    roots: () => chromiumProfileCaches(join(localAppData, "Microsoft", "Edge", "User Data")),
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["msedge"], blockerType: "process",
  },
  {
    id: "firefox-cache", group: "browser", scope: "system", name: "Firefox 网页缓存",
    detail: "Firefox 配置文件中的离线网页资源缓存。",
    impact: "书签、密码、历史和下载不受影响；网页资源会重新下载。",
    roots: () => firefoxProfileCaches(), risk: "review", defaultChecked: false, preserveRecent: true,
    blockers: ["firefox"], blockerType: "process",
  },
  {
    id: "inet-cache", group: "browser", scope: "system", name: "Windows 网页组件缓存",
    detail: "旧式网页控件和部分桌面应用使用的 INetCache 临时资源。",
    impact: "收藏、下载和文档不受影响；依赖网页组件的应用可能重新下载页面资源。",
    roots: () => [join(localAppData, "Microsoft", "Windows", "INetCache")],
    risk: "review", defaultChecked: false, preserveRecent: true,
    blockers: ["iexplore", "msedgewebview2"], blockerType: "process",
  },
  {
    id: "webview2-cache", group: "browser", scope: "system", name: "Edge WebView2 应用缓存",
    detail: "桌面应用内嵌网页视图使用的资源、代码和 GPU 缓存。",
    impact: "不会删除应用设置、账号或文档；相关应用下次打开可能重新下载界面资源。",
    roots: () => [
      join(localAppData, "Microsoft", "EdgeWebView", "User Data", "Default", "Cache"),
      join(localAppData, "Microsoft", "EdgeWebView", "User Data", "Default", "Code Cache"),
      join(localAppData, "Microsoft", "EdgeWebView", "User Data", "Default", "GPUCache"),
    ],
    risk: "review", defaultChecked: false, preserveRecent: true,
    blockers: ["msedgewebview2"], blockerType: "process",
  },
  {
    id: "windows-recent-items", group: "system", scope: "system", name: "Windows 最近项目历史",
    detail: "资源管理器最近打开项目的快捷方式历史，不触碰原始文件。",
    impact: "会清空最近项目列表；文档、图片和实际文件不会被删除。",
    roots: () => [join(roamingAppData, "Microsoft", "Windows", "Recent")],
    include: (name) => /\.(lnk|url)$/i.test(name), risk: "review", defaultChecked: false, preserveRecent: false,
    blockers: ["explorer"], blockerType: "process",
  },
  {
    id: "teams-cache", group: "apps", scope: "system", name: "Microsoft Teams 缓存",
    detail: "新版 Teams 的网页资源和图形缓存。",
    impact: "不会退出账号；下次启动会重建缓存，首次加载可能稍慢。",
    roots: () => [join(localAppData, "Packages", "MSTeams_8wekyb3d8bbwe", "LocalCache", "Microsoft", "MSTeams")],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["ms-teams", "teams"], blockerType: "process",
  },
  {
    id: "discord-cache", group: "apps", scope: "system", name: "Discord 媒体缓存",
    detail: "Discord 已下载的图片、媒体和代码缓存。",
    impact: "不会删除聊天记录；再次查看内容时会重新下载。",
    roots: () => [join(roamingAppData, "discord", "Cache"), join(roamingAppData, "discord", "Code Cache"), join(roamingAppData, "discord", "GPUCache")],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["discord"], blockerType: "process",
  },
  {
    id: "epic-cache", group: "gaming", scope: "system", name: "Epic Games 启动器缓存",
    detail: "Epic Games Launcher 内嵌网页界面的 webcache 目录。",
    impact: "不会删除已安装游戏或存档；启动器会重建界面缓存，个别账号可能需要重新登录。",
    roots: () => matchingChildDirectories(join(localAppData, "EpicGamesLauncher", "Saved"), /^webcache(?:_|$)/i),
    risk: "review", defaultChecked: false, preserveRecent: true,
    blockers: ["epicgameslauncher"], blockerType: "process",
  },
  {
    id: "battle-net-cache", group: "gaming", scope: "system", name: "Battle.net 启动器缓存",
    detail: "Battle.net 启动器保存的临时资源与下载元数据缓存。",
    impact: "不会删除游戏和存档；启动器可能重新校验或下载少量界面数据。",
    roots: () => [join(programData, "Battle.net", "Cache"), join(localAppData, "Battle.net", "Cache")],
    risk: "review", defaultChecked: false, preserveRecent: true,
    blockers: ["battle.net", "agent"], blockerType: "process",
  },
  {
    id: "adobe-media-cache", group: "apps", scope: "system", name: "Adobe 媒体缓存",
    detail: "Premiere Pro、After Effects 等应用生成的媒体索引与波形缓存。",
    impact: "不会删除工程或素材；重新打开工程时可能重新生成峰值、索引并暂时变慢。",
    roots: () => [join(roamingAppData, "Adobe", "Common", "Media Cache"), join(roamingAppData, "Adobe", "Common", "Media Cache Files")],
    risk: "review", defaultChecked: false, preserveRecent: true,
    blockers: ["adobe premiere pro", "afterfx", "adobe media encoder"], blockerType: "process",
  },
  {
    id: "onedrive-logs", group: "diagnostics", scope: "system", name: "OneDrive 诊断日志",
    detail: "OneDrive 同步客户端保存的旧运行日志和诊断记录。",
    impact: "同步文件不会被删除；会减少排查旧同步故障时可用的日志。",
    roots: () => [join(localAppData, "Microsoft", "OneDrive", "logs")],
    risk: "review", defaultChecked: false, preserveRecent: true,
    blockers: ["onedrive"], blockerType: "process",
  },
  {
    id: "vscode-cache", group: "development", scope: "system", name: "Visual Studio Code 缓存",
    detail: "编辑器的代码缓存、GPU 缓存和崩溃报告。",
    impact: "项目与设置不受影响；扩展或界面首次加载可能稍慢。",
    roots: () => [
      join(roamingAppData, "Code", "Cache"), join(roamingAppData, "Code", "CachedData"),
      join(roamingAppData, "Code", "Code Cache"), join(roamingAppData, "Code", "GPUCache"),
      join(roamingAppData, "Code", "Crashpad", "reports"),
    ],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["code"], blockerType: "process",
  },
  {
    id: "vscode-extension-cache", group: "development", scope: "system", name: "VS Code 扩展安装包缓存",
    detail: "VS Code 已下载并保留的扩展 VSIX 安装包副本。",
    impact: "已安装扩展和设置不受影响；重新安装某些扩展时可能需要再次下载。",
    roots: () => [join(roamingAppData, "Code", "CachedExtensionVSIXs")],
    risk: "safe", defaultChecked: false, preserveRecent: true, blockers: ["code"], blockerType: "process",
  },
  {
    id: "npm-cache", group: "development", scope: "system", name: "npm 下载缓存",
    detail: "npm 保存的包压缩文件与完整性缓存。",
    impact: "项目依赖不会被删除；未来安装依赖时可能需要重新下载。",
    roots: () => [join(localAppData, "npm-cache", "_cacache")],
    risk: "safe", defaultChecked: false, preserveRecent: false, blockers: ["node", "npm"], blockerType: "process",
  },
  {
    id: "pip-cache", group: "development", scope: "system", name: "pip 下载缓存",
    detail: "Python pip 保存的 wheel、HTTP 响应与包下载缓存。",
    impact: "虚拟环境和已安装包不受影响；以后安装依赖时可能重新下载。",
    roots: () => [join(localAppData, "pip", "Cache")],
    risk: "safe", defaultChecked: false, preserveRecent: false, blockers: ["python", "pip"], blockerType: "process",
  },
  {
    id: "yarn-cache", group: "development", scope: "system", name: "Yarn 下载缓存",
    detail: "Yarn Classic 保存的可重新下载依赖包。",
    impact: "现有项目与 node_modules 不受影响；后续安装可能需要重新联网下载。",
    roots: () => [join(localAppData, "Yarn", "Cache")],
    risk: "safe", defaultChecked: false, preserveRecent: false, blockers: ["node", "yarn"], blockerType: "process",
  },
  {
    id: "pnpm-store", group: "development", scope: "system", name: "pnpm 内容寻址缓存",
    detail: "pnpm store 中可从 registry 重新取得的包内容。默认不选，适合开发机按需清理。",
    impact: "现有 node_modules 和项目源码不受影响；离线安装或构建可能需要重新下载依赖。",
    roots: () => [join(localAppData, "pnpm", "store"), join(userProfile, ".pnpm-store")],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["node", "pnpm"], blockerType: "process",
  },
  {
    id: "gradle-cache", group: "development", scope: "system", name: "Gradle 下载缓存",
    detail: "Gradle wrapper 与依赖模块的本地下载缓存。默认不选。",
    impact: "不会删除项目源码或构建目录；后续 Android/Java 构建可能重新下载依赖。",
    roots: () => [join(userProfile, ".gradle", "caches"), join(userProfile, ".gradle", "wrapper", "dists")],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["java", "gradle", "studio64"], blockerType: "process",
  },
  {
    id: "maven-cache", group: "development", scope: "system", name: "Maven 本地仓库缓存",
    detail: "Maven 下载的依赖包与元数据。默认不选，适合释放开发环境空间。",
    impact: "不会删除项目源码；离线构建可能暂时缺少依赖，联网后会自动重新取得。",
    roots: () => [join(userProfile, ".m2", "repository")],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["java", "mvn", "maven"], blockerType: "process",
  },
  {
    id: "cargo-cache", group: "development", scope: "system", name: "Cargo 依赖下载缓存",
    detail: "Rust Cargo registry 中可从远端重新取得的包归档。",
    impact: "项目源码和编译产物不受影响；离线构建可能暂时缺少依赖并需要重新下载。",
    roots: () => [join(userProfile, ".cargo", "registry", "cache")],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["cargo", "rustc"], blockerType: "process",
  },
  {
    id: "nuget-cache", group: "development", scope: "system", name: "NuGet 包缓存",
    detail: ".NET 工具保存的可重新下载包缓存。",
    impact: "不会删除项目；下次构建可能重新下载依赖并花费更长时间。",
    roots: () => [join(userProfile, ".nuget", "packages")],
    risk: "review", defaultChecked: false, preserveRecent: true, blockers: ["dotnet", "devenv", "msbuild"], blockerType: "process",
  },
  {
    id: "drive-recycle-bin", group: "drive", scope: "drive", name: "所选磁盘回收站",
    detail: "该磁盘中已放入回收站但尚未永久删除的内容。",
    impact: "清理后无法从回收站还原这些文件。",
    roots: (drive) => [join(`${drive.letter}:\\`, "$Recycle.Bin")],
    risk: "destructive", defaultChecked: false, preserveRecent: false,
  },
  {
    id: "steam-shader-cache", group: "gaming", scope: "drive", name: "Steam 着色器缓存",
    detail: "所选磁盘 Steam 库中的游戏着色器缓存。",
    impact: "不会删除游戏存档；相关游戏首次启动可能重新处理着色器。",
    roots: (drive) => [
      join(`${drive.letter}:\\`, "SteamLibrary", "steamapps", "shadercache"),
      join(`${drive.letter}:\\`, "Program Files (x86)", "Steam", "steamapps", "shadercache"),
    ],
    risk: "review", defaultChecked: false, preserveRecent: false, blockers: ["steam"], blockerType: "process",
  },
  {
    id: "steam-incomplete", group: "gaming", scope: "drive", name: "Steam 未完成下载",
    detail: "所选磁盘 Steam 库中正在下载或暂停的临时游戏数据。",
    impact: "直接删除会丢失下载进度，因此这里只分析大小；请在 Steam 下载管理中处理。",
    roots: (drive) => [
      join(`${drive.letter}:\\`, "SteamLibrary", "steamapps", "downloading"),
      join(`${drive.letter}:\\`, "Program Files (x86)", "Steam", "steamapps", "downloading"),
    ],
    risk: "analysis", defaultChecked: false, preserveRecent: true, analysisOnly: true,
  },
  {
    id: "drive-temp", group: "drive", scope: "drive", name: "所选磁盘 TEMP 目录",
    detail: "仅识别磁盘根目录下名称恰好为 TEMP 或 TMP 的目录。",
    impact: "可能包含第三方软件仍需使用的数据，因此只分析，不提供自动删除。",
    roots: (drive) => [join(`${drive.letter}:\\`, "TEMP"), join(`${drive.letter}:\\`, "TMP")],
    risk: "analysis", defaultChecked: false, preserveRecent: true, analysisOnly: true,
  },
];

function safeNumber(value) {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isInside(root, target) {
  const base = resolve(root).toLowerCase();
  const candidate = resolve(target).toLowerCase();
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

async function chromiumProfileCaches(userData) {
  let entries;
  try { entries = await readdir(userData, { withFileTypes: true }); } catch { return []; }
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(Default|Profile \d+|Guest Profile)$/i.test(entry.name)) continue;
    const profile = join(userData, entry.name);
    roots.push(join(profile, "Cache", "Cache_Data"), join(profile, "Code Cache"), join(profile, "GPUCache"));
  }
  return roots;
}

async function firefoxProfileCaches() {
  const profiles = join(localAppData, "Mozilla", "Firefox", "Profiles");
  let entries;
  try { entries = await readdir(profiles, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(profiles, entry.name, "cache2"));
}

async function matchingChildDirectories(parent, pattern) {
  let entries;
  try { entries = await readdir(parent, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => join(parent, entry.name));
}

async function microsoftStoreCaches() {
  const packagesRoot = join(localAppData, "Packages");
  let packages;
  try { packages = await readdir(packagesRoot, { withFileTypes: true }); } catch { return []; }
  const roots = [];
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const localCache = join(packagesRoot, entry.name, "LocalCache");
    try {
      const info = await lstat(localCache);
      if (info.isDirectory() && !info.isSymbolicLink()) roots.push(localCache);
    } catch { /* The package may have been removed between discovery and scan. */ }
  }
  return roots;
}

async function resolveRoots(definition, drive) {
  const roots = await definition.roots(drive);
  return [...new Set(roots.map((root) => resolve(root)))];
}

function baseResult() {
  return {
    bytes: 0, eligibleBytes: 0, files: 0, eligibleFiles: 0, directories: 0,
    skippedLinks: 0, recentProtected: 0, failed: 0, pathsFound: 0, partial: false,
  };
}

async function scanRoot(root, definition, deadline) {
  const result = baseResult();
  let rootStat;
  try { rootStat = await lstat(root); }
  catch (error) { if (error.code !== "ENOENT") result.failed += 1; return result; }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) { result.skippedLinks += 1; return result; }
  result.pathsFound = 1;
  const queue = [root];
  let inspected = 0;

  while (queue.length > 0) {
    if (Date.now() > deadline || inspected >= scanEntryLimit) { result.partial = true; break; }
    const current = queue.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") result.failed += 1; continue; }

    for (const entry of entries) {
      if (Date.now() > deadline || inspected >= scanEntryLimit) { result.partial = true; break; }
      inspected += 1;
      const target = join(current, entry.name);
      if (!isInside(root, target) || entry.isSymbolicLink()) { result.skippedLinks += 1; continue; }
      if (entry.isDirectory()) { result.directories += 1; queue.push(target); continue; }
      if (!entry.isFile() || (definition.include && !definition.include(entry.name))) continue;
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) { result.skippedLinks += 1; continue; }
        const size = safeNumber(info.size);
        result.bytes += size;
        result.files += 1;
        const recent = definition.preserveRecent && Date.now() - info.mtimeMs < recentFileWindowMs;
        if (recent) result.recentProtected += 1;
        else { result.eligibleBytes += size; result.eligibleFiles += 1; }
      } catch (error) {
        if (error.code !== "ENOENT") result.failed += 1;
      }
    }
  }
  return result;
}

async function getDrives() {
  if (process.platform !== "win32") return [];
  const systemLetter = (windowsDirectory[0] || "C").toUpperCase();
  const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
  const drives = await Promise.all(letters.map(async (letter) => {
    try {
      const root = `${letter}:\\`;
      const info = await statfs(root);
      const blockSize = safeNumber(info.bsize);
      const total = blockSize * safeNumber(info.blocks);
      const free = Math.min(total, blockSize * safeNumber(info.bavail));
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) return null;
      return {
        letter, label: letter === systemLetter ? "系统盘" : "本地磁盘", filesystem: "",
        total, free, used: Math.max(0, total - free), system: letter === systemLetter,
      };
    } catch { return null; }
  }));
  return drives.filter(Boolean);
}

async function getVolumeHealth() {
  // Volume health queries used PowerShell and triggered security heuristics. The
  // dashboard now reports capacity only; destructive actions still re-check paths.
  return new Map();
}

function diskStatus(drive, health) {
  const freeRatio = drive.total > 0 ? drive.free / drive.total : 0;
  const healthText = String(health?.health || "未知");
  if (healthText !== "未知" && healthText !== "Unknown" && healthText !== "Healthy") return { status: "check", statusLabel: "需要检查", reason: `卷健康：${healthText}` };
  if (freeRatio < 0.12) return { status: "pressure", statusLabel: "空间紧张", reason: `仅剩 ${Math.round(freeRatio * 100)}% 可用` };
  return { status: "good", statusLabel: "空间正常", reason: `剩余 ${Math.round(freeRatio * 100)}%` };
}

async function getSystemStatus() {
  const [drives, volumeHealth] = await Promise.all([getDrives(), getVolumeHealth()]);
  const statusDrives = drives.map((drive) => {
    const health = volumeHealth.get(drive.letter) || { health: "未知", operational: "未知" };
    return { ...drive, healthStatus: health.health, operationalStatus: health.operational, ...diskStatus(drive, health) };
  });
  const recommendations = [];
  for (const drive of statusDrives.filter((item) => item.status === "pressure")) recommendations.push({ icon: "ph-hard-drive", title: `${drive.letter}: 空间紧张`, detail: "优先审阅缓存和诊断材料，保留个人文件与恢复资源。", risk: "删除缓存会带来重新下载或首次启动重建。" });
  for (const drive of statusDrives.filter((item) => item.status === "check")) recommendations.push({ icon: "ph-warning", title: `${drive.letter}: 先检查卷状态`, detail: `卷健康为 ${drive.healthStatus}，建议先运行 Windows 磁盘检查。`, risk: "在卷状态异常时不要批量删除文件。" });
  if (recommendations.length === 0) recommendations.push({ icon: "ph-check-circle", title: "当前没有紧急动作", detail: "固定磁盘的空间与卷状态都在可接受范围。", risk: "清理仍应逐项核对影响，不建议为了数字强行释放。" });
  return { drives: statusDrives, recommendations, observedAt: new Date().toISOString() };
}

async function getRunningProcesses() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFile("tasklist.exe", ["/FO", "CSV", "/NH"], { timeout: 5000, windowsHide: true });
    return stdout.split(/\r?\n/)
      .map((line) => line.match(/^"([^"]+)"/)?.[1]?.replace(/\.exe$/i, "").toLowerCase())
      .filter(Boolean);
  } catch { return []; }
}

async function getRunningServices(names) {
  if (process.platform !== "win32") return [];
  const found = [];
  for (const name of names) {
    try {
      const { stdout } = await execFile("sc.exe", ["query", name], { timeout: 2500, windowsHide: true });
      if (/STATE\s*:\s*4\s+RUNNING/i.test(stdout)) found.push(name.toLowerCase());
    } catch { /* A missing service is not a blocker. */ }
  }
  return found;
}

function blockedBy(definition, runningProcesses, runningServices) {
  if (!definition.blockers?.length) return [];
  const source = definition.blockerType === "service" ? runningServices : runningProcesses;
  return definition.blockers.filter((name) => source.includes(name.toLowerCase()));
}

async function scanCategory(definition, drive, runningProcesses, runningServices) {
  const deadline = Date.now() + scanTimeLimitMs;
  const roots = await resolveRoots(definition, drive);
  const rootResults = await Promise.all(roots.map((root) => scanRoot(root, definition, deadline)));
  const summary = rootResults.reduce((total, item) => ({
    bytes: total.bytes + item.bytes,
    eligibleBytes: total.eligibleBytes + item.eligibleBytes,
    files: total.files + item.files,
    eligibleFiles: total.eligibleFiles + item.eligibleFiles,
    directories: total.directories + item.directories,
    skippedLinks: total.skippedLinks + item.skippedLinks,
    recentProtected: total.recentProtected + item.recentProtected,
    failed: total.failed + item.failed,
    pathsFound: total.pathsFound + item.pathsFound,
    partial: total.partial || item.partial,
  }), baseResult());
  const blockers = blockedBy(definition, runningProcesses, runningServices);
  return {
    id: definition.id, group: definition.group, groupLabel: groupLabels[definition.group],
    name: definition.name, detail: definition.detail, impact: definition.impact, risk: definition.risk,
    defaultChecked: definition.defaultChecked, scope: definition.scope, analysisOnly: Boolean(definition.analysisOnly),
    available: summary.pathsFound > 0, blocked: blockers.length > 0, blockers,
    preserveRecent: Boolean(definition.preserveRecent), ...summary,
  };
}

async function runScan(requestedLetter) {
  const drives = await getDrives();
  if (drives.length === 0) throw new Error("没有读取到本地固定磁盘。");
  const drive = drives.find((item) => item.letter === String(requestedLetter || "").toUpperCase())
    ?? drives.find((item) => item.system) ?? drives[0];
  const [runningProcesses, runningServices] = await Promise.all([
    getRunningProcesses(), getRunningServices(["wuauserv", "bits", "FontCache"]),
  ]);
  const applicable = definitions.filter((definition) => definition.scope === "system" ? drive.system : true);
  const categories = await Promise.all(applicable.map((definition) => scanCategory(definition, drive, runningProcesses, runningServices)));
  const scanId = randomUUID();
  scanTickets.set(scanId, { createdAt: Date.now(), driveLetter: drive.letter, categoryIds: categories.map((item) => item.id) });
  for (const [id, ticket] of scanTickets) {
    if (Date.now() - ticket.createdAt > scanTicketLifetimeMs) scanTickets.delete(id);
  }
  return { scanId, drives, selectedDrive: drive, categories, scannedAt: new Date().toISOString(), recentProtectionHours: 24 };
}

async function deleteEntry(target, root, definition, report) {
  if (!isInside(root, target)) { report.skippedLinks += 1; return; }
  let info;
  try { info = await lstat(target); }
  catch (error) { if (error.code !== "ENOENT") report.failed += 1; return; }
  if (info.isSymbolicLink()) { report.skippedLinks += 1; return; }
  if (info.isDirectory()) {
    let entries;
    try { entries = await readdir(target, { withFileTypes: true }); }
    catch { report.failed += 1; return; }
    for (const entry of entries) await deleteEntry(join(target, entry.name), root, definition, report);
    try { await rmdir(target); report.directories += 1; } catch { /* Non-empty or recreated directory stays. */ }
    return;
  }
  if (!info.isFile() || (definition.include && !definition.include(basename(target)))) return;
  if (definition.preserveRecent && Date.now() - info.mtimeMs < recentFileWindowMs) { report.recentProtected += 1; return; }
  try {
    await rm(target, { force: true, maxRetries: 1, retryDelay: 80 });
    report.bytes += safeNumber(info.size);
    report.files += 1;
  } catch { report.failed += 1; }
}

async function cleanCategory(definition, drive) {
  const report = { id: definition.id, bytes: 0, files: 0, directories: 0, skippedLinks: 0, recentProtected: 0, failed: 0 };
  const roots = await resolveRoots(definition, drive);
  for (const root of roots) {
    let info;
    try { info = await lstat(root); }
    catch (error) { if (error.code !== "ENOENT") report.failed += 1; continue; }
    if (info.isSymbolicLink() || !info.isDirectory()) { report.skippedLinks += 1; continue; }
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch { report.failed += 1; continue; }
    for (const entry of entries) await deleteEntry(join(root, entry.name), root, definition, report);
  }
  return report;
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 32_768) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function cmdValue(value) {
  return String(value).replaceAll("%", "%%").replaceAll("\"", "\"\"");
}

function desktopLauncherText() {
  const serverScript = fileURLToPath(new URL("server.mjs", import.meta.url));
  const nodePath = process.execPath;
  return `@echo off
setlocal
set "NODE_EXE=${cmdValue(nodePath)}"
set "SERVER_SCRIPT=${cmdValue(serverScript)}"
if not exist "%NODE_EXE%" (
  echo 找不到 Node.js：%NODE_EXE%
  echo 请安装 Node.js 20 或更高版本后重试。
  exit /b 1
)
if not exist "%SERVER_SCRIPT%" (
  echo 找不到磁盘管家服务：%SERVER_SCRIPT%
  exit /b 1
)
start "" /min "%NODE_EXE%" "%SERVER_SCRIPT%" --open
endlocal
`.replace(/\r?\n/g, "\r\n");
}

function desktopCandidates() {
  const candidates = [
    process.env.OneDrive ? join(process.env.OneDrive, "Desktop") : "",
    join(userProfile, "OneDrive", "Desktop"),
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "Desktop") : "",
    join(userProfile, "Desktop"),
  ];
  return [...new Set(candidates.filter(Boolean))];
}

async function createDesktopLauncherFile() {
  if (process.platform !== "win32") throw new Error("桌面启动文件只支持 Windows。");
  let lastError;
  for (const directory of desktopCandidates()) {
    try {
      await mkdir(directory, { recursive: true });
      const target = join(directory, "磁盘管家.cmd");
      await writeFile(target, desktopLauncherText(), { encoding: "utf8" });
      return target;
    } catch (error) { lastError = error; }
  }
  throw new Error(lastError?.message || "找不到可写的桌面目录。");
}

async function getSafetyStatus() {
  const [drives, runningServices] = await Promise.all([
    getDrives(),
    getRunningServices(["wuauserv", "bits", "FontCache"]),
  ]);
  const serviceText = runningServices.length > 0
    ? `已监测 ${runningServices.length} 个相关服务，运行时对应项目会自动锁定。`
    : "更新与字体服务当前未运行；若以后启动，清理前仍会重新检查。";
  return {
    observedAt: new Date().toISOString(),
    checks: [
      { ok: true, title: "本机服务边界", detail: "服务只监听 127.0.0.1，不上传扫描结果。" },
      { ok: definitions.length > 0, title: "白名单清理范围", detail: `当前登记 ${definitions.length} 个分类，路径由程序固定声明。` },
      { ok: drives.length > 0, title: "固定磁盘读取", detail: drives.length > 0 ? `已识别 ${drives.length} 个固定磁盘，仅对选定磁盘扫描。` : "暂未读取到固定磁盘，请稍后重试。" },
      { ok: true, title: "高风险操作限制", detail: "还原点、休眠、页面文件、注册表和任意路径删除均未提供。" },
      { ok: true, title: "运行占用保护", detail: serviceText },
    ],
  };
}

async function serveStatic(response, route) {
  const item = staticFiles.get(route);
  if (!item) return false;
  try {
    const content = await readFile(new URL(item.file, import.meta.url));
    response.writeHead(200, {
      "Content-Type": item.type,
      "Cache-Control": item.cache ? "public, max-age=86400" : "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
    return true;
  } catch {
    sendJson(response, 500, { error: "无法读取本地界面文件。" });
    return true;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && await serveStatic(response, url.pathname)) return;

  const localAction = request.headers["x-local-action"] === "c-drive-steward";

  if (request.method === "POST" && url.pathname === "/api/shortcut") {
    if (!localAction) {
      sendJson(response, 403, { error: "本地操作来源无效。" });
      return;
    }
    try {
      const target = await createDesktopLauncherFile();
      sendJson(response, 200, { name: basename(target), path: target, format: "cmd" });
    } catch (error) {
      sendJson(response, 500, { error: `无法创建桌面启动文件：${error.message}` });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/desktop-launcher") {
    try {
      const content = desktopLauncherText();
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename*=UTF-8''%E7%A3%81%E7%9B%98%E7%AE%A1%E5%AE%B6-%E6%A1%8C%E9%9D%A2%E5%90%AF%E5%8A%A8%E5%99%A8.cmd",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(content, "utf8");
    } catch (error) {
      sendJson(response, 500, { error: `无法准备桌面启动器：${error.message}` });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/safety-status") {
    try { sendJson(response, 200, await getSafetyStatus()); }
    catch (error) { sendJson(response, 500, { error: error.message || "安全自检未完成。" }); }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/scan") {
    try { sendJson(response, 200, await runScan(url.searchParams.get("drive"))); }
    catch (error) { sendJson(response, 500, { error: error.message || "扫描未完成。" }); }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/system-status") {
    try { sendJson(response, 200, await getSystemStatus()); }
    catch (error) { sendJson(response, 500, { error: error.message || "无法读取系统状态。" }); }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/clean") {
    try {
      if (!localAction) {
        sendJson(response, 403, { error: "本地操作来源无效。" });
        return;
      }
      const body = await readBody(request);
      if (body.confirmation !== "确认清理") {
        sendJson(response, 400, { error: "请输入“确认清理”。" });
        return;
      }
      const ticket = scanTickets.get(String(body.scanId || ""));
      if (!ticket || Date.now() - ticket.createdAt > scanTicketLifetimeMs) {
        sendJson(response, 409, { error: "扫描结果已过期，请重新扫描后再清理。" });
        return;
      }
      const ids = Array.isArray(body.categories) ? [...new Set(body.categories.map(String))] : [];
      if (ids.length === 0 || ids.some((id) => !ticket.categoryIds.includes(id))) {
        sendJson(response, 400, { error: "清理范围无效，请重新选择。" });
        return;
      }
      const drives = await getDrives();
      const drive = drives.find((item) => item.letter === ticket.driveLetter);
      if (!drive) {
        sendJson(response, 409, { error: "所选磁盘已不可用。" });
        return;
      }
      const selected = definitions.filter((definition) => ids.includes(definition.id));
      if (selected.some((definition) => definition.analysisOnly)) {
        sendJson(response, 400, { error: "只分析项目不能自动清理。" });
        return;
      }
      const [processes, services] = await Promise.all([getRunningProcesses(), getRunningServices(["wuauserv", "bits", "FontCache"])]);
      const blocked = selected
        .filter((definition) => blockedBy(definition, processes, services).length > 0)
        .map((definition) => definition.name);
      if (blocked.length > 0) {
        sendJson(response, 409, { error: `以下项目关联的程序仍在运行：${blocked.join("、")}。关闭后重新扫描。` });
        return;
      }
      const results = [];
      for (const definition of selected) results.push(await cleanCategory(definition, drive));
      scanTickets.delete(body.scanId);
      sendJson(response, 200, {
        results,
        bytesRemoved: results.reduce((sum, item) => sum + item.bytes, 0),
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "无法处理清理请求。" });
    }
    return;
  }

  sendJson(response, 404, { error: "未找到该本地路径。" });
});

const serverUrl = `http://${host}:${port}/`;
const shouldOpen = process.argv.includes("--open");
function openBrowser() {
  if (process.platform === "win32") execFile("explorer.exe", [serverUrl], { windowsHide: true }).catch(() => {});
}
server.listen(port, host, () => {
  console.log(`C Drive Steward is running at ${serverUrl}`);
  if (shouldOpen) setTimeout(openBrowser, 250);
});
server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && shouldOpen) {
    setTimeout(openBrowser, 50);
    return;
  }
  console.error(`Unable to start C Drive Steward: ${error.message}`);
  process.exitCode = 1;
});
