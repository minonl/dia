# launchd：bw broker 常驻

```bash
# 演练：只打印将要做的事
packaging/launchd/install.sh --dry-run
# 安装（可选自动解锁；密码文件必须 0600）
packaging/launchd/install.sh --yes [--passwordfile ~/.config/dia/bw-password]
launchctl list | grep dia-bw-broker
# 卸载
packaging/launchd/uninstall.sh
```

- 解锁：模板默认带 `--passwordfile @BW_PASSWORD_FILE@`（启动即解锁，失败则 broker 不启动，fail-closed）；不想自动解锁就把这两行删掉，改用 `dia env bw unlock`
- 停止：`launchctl unload -w ~/Library/LaunchAgents/com.minzhao.dia-bw-broker.plist`
- 检查：`dia env bw status`、`ls -l ~/.local/share/dia/state/bw.sock`（应为 0600）
- 注意：broker 只是把 session 收在一个进程里；同 OS 用户仍可读 session 文件（0600 只挡其它用户）
