# Sub2API Pet

Sub2API Pet 是一个常驻桌面的 Codex 周额度悬浮客户端，使用 Tauri 2 构建。

## 功能

- 透明、无边框、始终置顶的桌面宠物窗口
- 展示账号池中全部 OpenAI/Codex 与 Claude（Anthropic）账号额度
- 每 30 秒读取 Sub2API 已缓存的额度数据
- 右键宠物打开独立操作面板，可刷新额度、进入设置或打开管理后台
- Claude 优先展示 7 日窗口，缺失时回退到 5 小时窗口
- 任一账号低于 15% 时切换告警状态
- 支持 Sub2API 两步验证、access token 自动续期
- refresh token 保存在系统钥匙串，密码不会落盘
- 菜单栏常驻、开机启动和窗口位置保留由系统窗口管理
- 启动时根据 GitHub Release 自动检查更新，下载包通过签名校验后安装并重启

## 使用

1. 安装并打开 `Sub2API Pet`。
2. 输入 Sub2API 站点地址，例如 `https://sub2api.example.com`。
3. 使用管理员邮箱和密码登录；开启两步验证时继续输入 6 位验证码。
4. 宠物面板会自动列出账号池中的全部 Codex / Claude 账号及剩余额度。

客户端会自动补全 `/api/v1`。远程地址必须使用 HTTPS，本地开发允许 `localhost`。

## 开发

```bash
npm install
npm run tauri dev
```

验证和打包：

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build
```

macOS 安装包生成在 `src-tauri/target/release/bundle/dmg/`。

## 发布与自动升级

自动升级读取仓库 Release 中的 `latest.json`。首次发布前，将本机
`.tauri/sub2api.key` 的完整内容保存为 GitHub Actions Secret
`TAURI_SIGNING_PRIVATE_KEY`；当前密钥没有密码，因此
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 留空即可。私钥只用于发布签名，不能提交到仓库。

发布前同步修改 `package.json`、`src-tauri/Cargo.toml` 和
`src-tauri/tauri.conf.json` 中的版本号，然后推送对应 tag：

```bash
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions 会构建 macOS、Windows 和 Linux 安装包，生成 updater 签名及
`latest.json`，全部平台成功后再公开 Release。已安装的客户端会在启动 3 秒后检查，
也可以在设置页手动检查更新。
