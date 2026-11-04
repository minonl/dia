# launchd：bw broker 常驻

```bash
mkdir -p ~/Library/LaunchAgents ~/.local/share/dia/logs
sed -e "s#@DIA_BIN@#$HOME/.local/bin/dia#g" -e "s#@HOME@#$HOME#g" \
  packaging/launchd/com.minzhao.dia-bw-broker.plist.template \
  > ~/Library/LaunchAgents/com.minzhao.dia-bw-broker.plist
launchctl load -w ~/Library/LaunchAgents/com.minzhao.dia-bw-broker.plist
launchctl list | grep dia-bw-broker
```

- 前置：先 `dia env bw unlock --passwordfile <0600 文件>`（session 落盘后才可取用）
- 停止：`launchctl unload -w ~/Library/LaunchAgents/com.minzhao.dia-bw-broker.plist`
- 检查：`dia env bw status`、`ls -l ~/.local/share/dia/state/bw.sock`（应为 0600）
- 注意：broker 只是把 session 收在一个进程里；同 OS 用户仍可读 session 文件（0600 只挡其它用户）
