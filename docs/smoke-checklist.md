# Lawcaspro-v5 Smoke Checklist (Pre-Manual-QA)

目标：快速验证“最容易回归”的导航、缓存刷新、权限/会话错误态与重复提交防呆。每项只做关键路径，不做深度业务验算。

## 登录 / Session
- 登录（正常账号）：成功后跳到正确 workspace（firm_user → `/app/dashboard`，founder → `/platform/dashboard`）
- 登录（错误密码）：提示清晰，不白屏，不残留半登录状态
- 2FA：需要 2FA 时进入输入码步骤；取消返回后状态清空；重复提交按钮在 pending 时不可点
- Session 失效（401）：任意页面请求触发后，前端状态清空并回到登录态；刷新页面后仍一致

## Dashboard
- 打开 `/app/dashboard`：正常渲染；错误态显示可重试；刷新页面后数据一致

## Developers / Projects / Cases
- Developers list：打开/搜索/进入 detail；创建/编辑/删除后返回列表立即看到最新；刷新后仍一致
- Projects list：打开/进入 detail；编辑/删除后返回列表立即看到最新；刷新后仍一致
- Cases list：打开/筛选/保存 view/重命名/删除 view；导出 CSV；刷新后筛选与数据一致

## Case Detail（所有 Tabs）
- 从 list 进入 detail：切换 URL id（浏览器前进/后退或手动改 id）不残留旧数据
- Workflow：完成 step 后提示清晰；返回 list 立即反映状态；刷新后仍一致
- Notes：新增/编辑（如有）后不残留旧内容；错误态提示清晰
- Key Dates：保存后返回 list 立即反映状态；刷新后仍一致
- Documents：上传/生成/下载/删除；pending 禁用；错误态可重试；删除后列表不残留
- Communications：创建 subject/发消息/删除 subject；切换 thread 不串消息；pending 禁用；错误态可重试
- Billing：新增/删除/标记 paid；pending 禁用；删除二次确认；错误态可重试
- Time：新增/删除；pending 禁用；删除二次确认；错误态可重试
- Compliance / Conflict：查询失败不“伪装空数据”；override 等敏感操作需要 re-auth 时提示清晰

## Quotations
- Quotations list：新建/进入 detail；duplicate/delete 后列表立即更新；按钮 pending 禁用；错误提示清晰
- Quotation detail：编辑保存后返回列表数据一致；刷新后仍一致

## Accounting
- Invoices：从 quotation 创建 invoice；issue/void（如需要 re-auth）提示清晰；pending 禁用；返回列表立即更新
- Receipts：创建/反转；关联 invoice 状态变化及时；pending 禁用；ledger summary 立即更新
- Payment vouchers：创建/状态流转；pending 禁用；ledger summary 立即更新
- Ledger：切换 accountType 过滤与刷新一致；错误态可重试

## Documents（App）
- Hub documents：folder 切换/下载；错误态可重试；刷新后仍一致
- Firm documents：folder/file 上传/下载/删除；pending 禁用；删除后不残留
- Letterhead：上传/设默认/下载模板/删除；pending 禁用；错误态可重试

## Settings
- Me / sessions：sessions 列表加载/错误态可重试；revoke session 后列表立即更新；刷新后仍一致
- 2FA enable/disable：成功后状态一致；失败提示清晰
- Firm settings：编辑后即时生效；无权限（403）提示清晰

## Communications / Hub
- Communications list：删除记录二次确认；pending 禁用；删除后列表立即刷新
- Thread detail：加载失败不白屏；错误态可重试；刷新后仍一致
- Hub messages：发送（含附件上传）/下载附件；pending 禁用；错误态可重试

## Reports / Audit Logs
- Reports（overview + 单项报表）：加载失败不白屏；错误态可重试；下载 CSV 失败提示清晰
- Audit logs（app + platform）：加载失败不白屏；错误态可重试；筛选/搜索可用；刷新后仍一致

