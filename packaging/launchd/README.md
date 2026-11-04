# launchd：bw broker 常驻

```bash
mkdir -p ~/Library/LaunchAgents ~/.local/share/dia/logs
sed -e "s#@DIA_BIN@#$HOME/.local/bin/dia#g" -e "s#@HOME@#$HOME#g" \
  -e "s#@BW_PASSWORD_FILE@#$HOME/.config/dia/bw-password#g" \
  # 密码文件必须 0600，且只用 `--passwordfile`（不要 export BW_PASSWORD）
  packaging/launchd/com.minzhao.dia-bw-broker.plist.template \
  > ~/Library/LaunchAgents/com.minzhao.dia-bw-broker.plist
launchctl load -w ~/Library/LaunchAgents/com.minzhao.dia-bw-broker.plist
launchctl list | grep dia-bw-broker
```

- 解锁：模板默认带 `--passwordfile @BW_PASSWORD_FILE@`（启动即解锁，失败则 broker 不启动，fail-closed）；不想自动解锁就把这两行删掉，改用 `dia env bw unlock`
- 停止：`launchctl unload -w ~/Library/LaunchAgents/com.minzhao.dia-bw-broker.plist`
- 检查：`dia env bw status`、`ls -l ~/.local/share/dia/state/bw.sock`（应为 0600）
- 注意：broker 只是把 session 收在一个进程里；同 OS 用户仍可读 session 文件（0600 只挡其它用户）
