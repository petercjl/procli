# procli

`procli` 是自建项目管理系统面向人和 Agent 的稳定 CLI。npm 包同时分发唯一真源的 `project-management` Skill；Codex 和 SealSeek 使用同一台机器上的同一个 CLI。

```bash
npm install -g @petercjl/procli@latest
procli profile add nas --url http://NAS地址:14317 --environment production
procli auth login --profile nas
procli skill install --agent codex
procli skill install --agent sealseek
```

CLI 与 Skill 真源都位于全局 npm 包中。Codex 的发现目录使用指向包内 Skill 的链接；SealSeek 的活动工作区需要实体副本，`skill install --agent sealseek` 会复制并登记到工作区和技能池。升级 npm 包后运行 `procli skill update --agent codex` 和 `procli skill update --agent sealseek`，再新建 Agent 对话以刷新技能清单。非默认 SealSeek 工作区可设置 `SEALSEEK_WORKSPACE` 或传入 `--target-dir` 指向 `workspaces/<工作区>/skills`。

默认 Profile 是 `nas`。开发时可持久切换到本地，或只覆盖一条命令：

```bash
procli profile add local --url http://127.0.0.1:4317 --environment development
procli profile use local
procli --profile nas project create --name "NAS 测试项目" --goal "验证最终服务" --yes
```

创建生产项目支持目标确认、幂等和写后回读：

```bash
procli project create --name "新品项目" --goal "完成市场验证与上市" --yes
```

只读命令可直接查询目录、项目和任务记录：

```bash
procli directory list
procli task list --project "新品项目"
procli task get --project "新品项目" --task "完成市场与竞品调研"
```

`task get` 返回节点当前状态、状态历史、依赖、活动记录、Agent 运行、交付物、Wiki 元数据和通知。

项目知识采用关系元数据、钉钉原文、不可变 Markdown 来源快照、报告证据页，以及按节点持续编译的 `current.md`。项目 `index.md` 和 `queries/index.md` 优先路由到当前知识；节点目录保存各期来源和历史记录，用于核对差异与证据。Agent 读取已有综合页及全部活跃来源，按知识点更新结论、标明证据时间窗与尚未解决的分歧，再经 `procli knowledge compile` 保存；服务端归档上一版并记入 `wiki/log.md`。钉钉文档由具备权限的官方 `dws` 创建并回读；`knowledge source-check` 可按需核验原文是否更新。

```bash
procli knowledge context --project "新品项目" --task "完成市场与竞品调研" --json
procli knowledge index --project "新品项目" --node "市场调研" --json
procli knowledge reindex --project "新品项目" --context-token "<knowledge index 返回的令牌>" --dry-run --json
procli knowledge ingest --project "新品项目" --task "完成市场与竞品调研" \
  --title "市场调研报告" --source-node "<钉钉 nodeId>" \
  --source-url "https://alidocs.dingtalk.com/i/nodes/<nodeId>" \
  --source-version "<真实来源版本或读回时间>" --workspace "<知识库 workspaceId>" \
  --file ./verified-source.md --wiki-file ./knowledge-summary.md \
  --analysis-date "2026-09-16" --platform "跨平台公开资料" --topics "容量,保冷,竞品" \
  --context-token "<当前令牌>" \
  --idempotency-key "<UUID>" --dry-run --json
procli knowledge query --project "新品项目" --node "市场调研" --json
procli knowledge compile-context --project "新品项目" --node "市场调研" --json
procli knowledge compile --project "新品项目" --node "市场调研" \
  --file ./market-current.md --source-ids "<来源知识ID1,来源知识ID2>" \
  --change-summary "叠加两期调研，记录一致结论与待核查差异" \
  --context-token "<编译上下文令牌>" --current-version 1 \
  --idempotency-key "<UUID>" --dry-run --json
procli knowledge query --project "新品项目" --node "市场调研" \
  --reports --platform "跨平台公开资料" --topic "保冷" --from "2026-01-01" --json
procli knowledge source-context --project "新品项目" --knowledge-id "<知识ID>" --json
procli knowledge source-check --project "新品项目" --knowledge-id "<知识ID>" \
  --context-token "<来源上下文令牌>" --dry-run --json
```

预演核对后移除 `--dry-run` 写入；生产 Profile 还需要 `--yes`。返回的 `knowledgeId`、来源快照和编译页均会回读验证。来源检查通过 `dws` 读取完整正文并比较 SHA-256；发现变化后将节点当前知识标记为待重新编译。任务或节点删除会归档项目侧知识关系与本地快照，原始钉钉文档保留不动，恢复时重建项目侧关系。

任务编辑和 Agent 执行采用项目级写前令牌。每次写入后都要重新获取上下文，因为项目版本会变化：

```bash
procli task update-context --project "新品项目" --task "完成市场与竞品调研" --json
procli task update --project "新品项目" --task "完成市场与竞品调研" \
  --progress 45 --context-token "<令牌>" --task-version 3 --dry-run --json
procli run start --project "新品项目" --task "完成市场与竞品调研" \
  --skill "市场调研" --context-token "<新令牌>" --task-version 4 --dry-run --json
procli artifact upload --project "新品项目" --task "完成市场与竞品调研" \
  --file ./market-report.pdf --context-token "<新令牌>" --task-version 5 --dry-run --json
procli run finish-context --project "新品项目" --task "完成市场与竞品调研" --run-id "<运行ID>" --json
procli run finish --project "新品项目" --task "完成市场与竞品调研" \
  --run-id "<运行ID>" --run-version 1 --status completed \
  --output "完成市场判断与机会总结" --artifact-id "<附件ID>" \
  --context-token "<新令牌>" --task-version 6 --dry-run --json
procli task submit --project "新品项目" --task "完成市场与竞品调研" \
  --context-token "<新令牌>" --task-version 7 --dry-run --json
```

提交、审核通过和驳回会进入通知队列。管理员绑定成员的精确钉钉 `userId` 后，可在配置好官方 `dws` 与应用机器人 Code 的运行环境启动发送 worker：

```bash
procli notification list --json
procli notification bind --member market --dingtalk-user-id "<userId>" --yes
PROCLI_DINGTALK_ROBOT_CODE="<机器人Code>" procli notification dispatch --dry-run --json
PROCLI_DINGTALK_ROBOT_CODE="<机器人Code>" procli notification worker --identity bot --yes
```

worker 应由本地进程管理器持续运行；可用 `PROCLI_DWS_PROFILE` 固定同一企业身份。钉钉消息发送结果不确定时会进入人工核对状态。核实钉钉里确实未收到后，管理员可运行 `procli notification requeue --id "<通知ID>" --confirm-not-delivered --yes` 重新入队。

节点是看板中的阶段列。添加节点前先读取当前节点顺序，默认追加到末尾，也可以指定前后位置：

```bash
procli node create-context --project "新品项目" --json
procli node create --project "新品项目" --name "产品定价" \
  --after-node "市场调研" --context-token "<令牌>" \
  --idempotency-key "<UUID>" --dry-run --json
```

删除节点会把节点、其中的任务、Wiki、附件和执行记录作为一个批次放入回收站。其他节点存在下游依赖时默认阻止；`detach` 必须由用户明确选择。有实质产出的节点只能由管理员删除：

```bash
procli node delete-context --project "新品项目" --node "产品定价" --json
procli node delete --project "新品项目" --node "产品定价" \
  --confirm-node "产品定价" --dependency-policy block --dry-run --json
procli node restore --deletion-id "<deletionId>" \
  --confirm-node "产品定价" --dry-run --json
```

添加任务需要先读取精简写前快照。预演和真实写入使用同一个 `contextToken` 和幂等键；如果期间网页端或其他 Agent 修改了项目，写入会返回 `PROJECT_STATE_CHANGED`：

```bash
procli task create-context --project "新品项目" --json
procli task create --project "新品项目" --node "市场调研" \
  --title "整理亚马逊热销款价格带" \
  --description "统计前20款商品的价格、销量和主要卖点" \
  --context-token "<create-context 返回的令牌>" \
  --idempotency-key "<同一逻辑尝试的 UUID>" --dry-run --json
```

本地 Profile 确认预演后移除 `--dry-run` 即可写入；生产 Profile 还需要 `--yes`。新任务默认添加到节点末尾，可使用 `--before-task`、`--after-task` 指定位置，使用 `--depends-on` 显式指定依赖。

任务删除采用可恢复链路。CLI 会读取当前状态、计算影响哈希，并把任务 Wiki、历史版本和附件移动到按 `deletionId` 隔离的回收目录。存在下游依赖时默认阻止删除，只有明确选择 `detach` 或 `rewire` 才会继续：

```bash
procli task delete-context --project "新品项目" --task "完成市场与竞品调研" --json
procli task delete --project "新品项目" --task "完成市场与竞品调研" \
  --confirm-task "完成市场与竞品调研" --dependency-policy block --dry-run --json
procli task delete --project "新品项目" --task "完成市场与竞品调研" \
  --confirm-task "完成市场与竞品调研" --dependency-policy detach \
  --idempotency-key "<UUID>" --json
```

查看回收记录并恢复任务：

```bash
procli trash list --project "新品项目" --json
procli trash get --deletion-id "<deletionId>" --json
procli task restore --deletion-id "<deletionId>" \
  --confirm-task "完成市场与竞品调研" --dry-run --json
```

恢复写入时移除 `--dry-run`；生产 Profile 还需要 `--yes`。任务默认保留 90 天，当前版本不自动彻底清除。

商品项目默认生成标准生命周期 SOP。Agent 也可以提交自定义 SOP；每个节点都必须有名称和工作说明：

```json
{
  "nodes": [{ "name": "验证需求", "description": "取得真实用户证据并形成结论" }]
}
```

```bash
procli project create --name "新品验证" --sop-file ./sop.json
```

删除项目仅允许系统管理员执行，必须先预览、精确复述项目名称并显式确认。删除是可恢复的软删除：

```bash
procli project delete --name "新品验证" --confirm-name "新品验证" --dry-run
procli project delete --name "新品验证" --confirm-name "新品验证" --yes
```

店铺项目和企业项目已保留为后续能力，目前 CLI 会返回 `FEATURE_UNSUPPORTED`。

配置和每个 Profile 的个人凭证保存在用户配置目录，不进入 npm 包或项目仓库。运行 `procli doctor --json` 查看当前 Profile、服务指纹和认证状态。
