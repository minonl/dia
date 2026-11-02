Staff 用户曾经进入过某个组织后，再访问 `/login`，会被错误地送进那家 org。

请修复登录后的分流：已登录会话应按 token 级别决定落地页——org 级 token 去 `/org/{orgId}`，staff 主 token 去 `/staff`；未登录保持登录页。不要修改测试文件，修完运行相关测试。
