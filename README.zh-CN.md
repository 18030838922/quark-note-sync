**简体中文** · [English](README.md)

# 夸克笔记同步

这是一个 Obsidian 社区插件，在 Windows 桌面版和 Android 版 Obsidian 之间直接通过夸克网盘同步笔记。每台设备分别连接夸克；不需要电脑中转、Termux、局域网或常驻辅助服务。

插件通过夸克个人网盘的非官方网页接口工作。夸克可能调整接口或账号权限，届时连接或同步可能需要更新插件。

## 支持内容与同步规则

- Markdown、Canvas 和附件文件，单文件上限为 10 MiB。
- Obsidian 配置目录不参与同步。普通插件设置保存在本 Vault 本机的 `data.json`；Cookie 单独保存在 Obsidian SecretStorage 中。
- 每个 Vault 使用一个专用的夸克目录；同一 Vault 的所有设备都填写该目录。不要让不同 Vault 共用一个目录。
- 首次同步先预览，再由用户确认执行。“打开 Obsidian 时同步”和定时同步默认关闭，可在首次同步完成后分别开启。启动同步在仓库载入后执行一次。定时同步默认每 5 分钟执行，只在 Obsidian 打开期间运行。
- Windows 可使用夸克普通网页扫码登录；Android 可本地导入 Windows 生成的加密授权码。授权码只通过本地加密包含夸克会话和专用目录信息，不含笔记、同步历史或电脑绝对路径。
- Cookie 只用于向夸克发出的 HTTPS 请求；Cookie 和授权密码不写入插件 `data.json`、笔记同步数据或日志。手动 Cookie 仍保留为高级设置中的备用方式。
- 并发编辑会保留冲突副本为本地 `.quark-sync-conflicts/` 下的文件，该目录不再参与同步。同步删除遵循 Obsidian 的文件删除偏好。若使用回收站，可通过对应的回收站恢复文件。删除与编辑并发时保留编辑内容。
- 云端版本记录采用追加方式。插件不会调用夸克的永久删除接口；同步内容和历史记录会保留在夸克目录中。

## 同步面板

点击 Obsidian 左侧功能区的云朵图标，或从命令面板运行「打开同步面板」。可直接在左侧页签发起同步、查看并确认首次同步预览，以及调整自动同步。侧栏也显示夸克网盘容量、笔记库分类占用、最近一次同步结果和占用最大的五个文件。

笔记库统计基于 Obsidian 已索引的文件大小。面板无需读取笔记正文。网盘容量是整个夸克账号的用量，仅在夸克返回有效数据时显示。

## 安装

1. 从 [GitHub Releases](https://github.com/18030838922/quark-note-sync/releases/latest) 下载 `manifest.json`、`main.js` 和 `styles.css`。
2. 将这三个文件直接放进笔记库的 `.obsidian/plugins/quark-note-sync/` 文件夹。
3. 在 Obsidian 设置 → 第三方插件中，关闭受限模式（如尚未关闭），重新加载插件列表并启用“Quark Note Sync”。
4. Android 的 Vault 文件夹与桌面版一样有 `.obsidian/plugins/` 目录。将发布文件复制到 Vault 实际所在的设备存储路径；使用能显示隐藏文件、且能访问 Vault 所在存储位置的文件管理器操作，部分设备需要在系统文件选择器中先授予该 Vault 的访问权限。

插件使用 Obsidian SecretStorage 保存 Cookie，因此要求 Obsidian 1.11.4 或更新版本；该版本要求也写在 `manifest.json` 中。

## 首次连接与同步

插件设置默认使用简体中文。可通过页面顶部的「语言 / Language」切换为 English，所选语言会自动保存。

1. 在 Windows Obsidian 的 Quark Note Sync 设置页中点击“扫码登录”，用自己的夸克 App 扫码并确认。插件只在读取账号信息和夸克根目录成功后，才会将网页登录会话保存在本机 Obsidian SecretStorage。
2. 填写专用夸克云端目录名称，并设置设备名称。若尚未有目标目录，请先在夸克官方网页端手动创建；插件的“导出到手机”只读取目标目录，不会为了导出而创建云端文件夹。首次同步也可在确认后创建目标目录，再导出授权。
3. 运行“检查夸克连接”和“预览同步”。确认预览中的目标和文件变化后，再手动确认首次同步。
4. 在 Android Obsidian 中安装并启用本插件，点击“导入电脑授权”，粘贴 Windows 端导出的授权码并输入相同密码。导入前会在线验证账号 ID 和云端根目录 ID；不会自动开始同步。新设备的自动同步保持关闭，需先预览并手动确认首次同步。
5. 在 Windows 端选择“导出到手机”，设置至少 12 位的独立密码，复制授权码。通过你自己选择的方式把授权码传到手机，并通过另一种方式传递密码。授权码使用 PBKDF2-SHA256 与 AES-256-GCM 加密，含随机盐和随机 IV，15 分钟有效；有效期内可重复导入。授权码与密码都只在设备本地处理，不会由插件上传。
6. 如果设备已有同步历史，导入会验证它与授权码属于同一夸克账号和同一个目录；无法验证或不一致时会拒绝替换凭据，以免把旧快照用于其他账号或目录。账号和目标相同时，原设备设置和同步状态会保留。
7. 可在“高级设置（手动 Cookie）”中手动录入 Cookie，作为扫码或授权码不可用时的备用方式。旧版本已经保存的 Cookie 和同步设置仍可继续使用。
8. 登录成功后，“夸克账号”栏显示昵称或掩码账号标识。退出登录会清除当前设备保存的会话，保留同步历史和目录绑定。会话被夸克拒绝后，自动同步暂停，桌面端可重新扫码，手机端可重新导入授权。

建议先用专门的测试 Vault 和空的测试目录验证双向行为。导入只更换本设备凭据并验证目录；它不会代替同步预览或确认。

Windows 和 Android 分别向夸克直接发起 HTTPS 请求。Android 端依赖 Obsidian 提供的原生 HTTPS 接口；实际可用性需在目标设备和 Obsidian 版本上验证，不能仅由桌面构建或模拟测试推断。Android 8 及以上设备可作为计划验收范围，但该版本范围的原生 HTTP 二进制兼容性尚未得到验证。

## 本地构建与测试

开发环境：Node.js 24、npm、Windows PowerShell。依赖锁文件用于可重复安装。

```powershell
npm ci
npm run check
npm run build
npm run package
```

`npm run check` 执行 TypeScript 类型检查和隔离测试；这些测试使用模拟请求，不会登录夸克，也不能证明真实账号或 Android 原生网络能力可用。`npm run build` 生成 Obsidian 插件加载的 `main.js`。`npm run package` 检查、构建后生成：

```text
dist/quark-note-sync-<version>.zip
```

ZIP 内含 `quark-note-sync/manifest.json`、`quark-note-sync/main.js`，以及项目中存在时的 `quark-note-sync/styles.css`。

## 独立账号验收建议

请使用自己的夸克账号、Windows 扫码登录、加密授权码、临时 Vault 和单独的云端目录；不要在真实 Vault 或唯一副本上首次验证。

1. 在 Windows Obsidian 中做连接检查和首次预览，确认后执行；查看 Markdown、Canvas 和小于 10 MiB 的附件是否到达云端。
2. 在 Android Obsidian 中导入电脑授权，完成连接检查与预览确认；验证云端内容到本机、再从本机编辑回云端。
3. 同时离线编辑同一文件后分别连接，检查冲突副本和主文件；验证删除与编辑并发时编辑内容仍在，并按插件提示试用删除恢复。
4. 确认 Obsidian 配置文件未同步、冲突副本目录不会被再次同步、超过单文件上限的项目按插件提示处理。
5. 确认自动同步初始关闭；手动开启后，在 Obsidian 保持打开时观察设定间隔是否生效。分别重启 Windows 和 Android Obsidian 后再次连接检查。
6. 关闭或断开 Windows 主机，再从 Android 执行连接检查和同步，确认 Android 设备直接访问夸克，不依赖电脑、Termux、局域网或辅助服务。
7. 在目标 Android 版本上重复上传、下载与预览操作，特别验证原生 HTTPS 接口对请求头、重定向和二进制文件的支持。Android 8+ 的二进制兼容性需实机单独确认。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。随插件打包的依赖版权声明见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。

## 参考资料

- [夸克网盘 Skill 文档](https://www.quark.cn/documents/help/quark-drive-skill)
- [OpenList 夸克网盘驱动说明](https://doc.oplist.org.cn/guide/drivers/quark)
