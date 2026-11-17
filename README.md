# 楼栋抄表资料查看器

用于检查授权来源的原始资料并留存接收凭据。当前提供资料预览、原件接收、设备资料领取（首帧加续帧组合）、接收凭据与摘要回读，资料源可以在本地独立运行。

## 环境与运行

使用 Node.js 22.23.4，无第三方运行包。安装、检查与测试：

```sh
npm ci --ignore-scripts --offline
npm run build
npm test
npm run demo
```

`demo` 临时启动来源和查看服务，展示当前资料、核对保存后的原件，并完成一次设备资料领取；结束时关闭所有监听并移除临时目录。不会连接外部来源。`test` 校验已有预览、资料控制、原件持久化、续帧组合与领取会话；测试通过只说明当前版本已有能力正常。

需要交互时分别运行 `npm run source` 与 `npm start`。来源默认监听本机 4310 端口，应用默认监听 4320；可用 `PORT`、`SOURCE_URL`、`DATA_DIR` 配置。`GET /preview` 获取预览，`POST /receipts` 接收当前资料，`GET /receipts` 查询凭据，`GET /objects/<摘要>` 回读原件。应用只允许配置到本机的资料服务。

## 设备资料领取

`POST /readouts`（可传 `{"path": "/meter/2/read"}`，默认 `/meter/1/read`）完成一次领取：首帧要求继续读取时，按帧计数位（`fcb`）续读，直到没有后续记录。相关入口：

- `GET /readouts` 列出会话（设备身份、状态、帧数）。
- `GET /readouts/<编号>` 查看会话与台账：每条记录的数值都对应当时的记录定义（DIF/VIF 原文、单位、倍率）、存储号与费率。
- `POST /readouts/<编号>/resume` 在中断后续采。
- `GET /readouts/<编号>/quantity?kind=energy[&storage=..][&tariff=..]` 按量查询，区分 `resolved`（已得数值）、`not-provided`（设备确实没提供）、`incomplete`（尚未读完）、`uninterpreted`（收到但不能解释）。

领取遵守以下约束：网关重发的上一帧不算新读数；设备身份以识别号、厂家、版本、介质为准，主地址沿用不构成同一设备；身份不一致的续帧留证但绝不拼入；厂家扩展记录与未理解的单位、特殊数值只保留原字节，不按普通数字入账。会话进度（已收帧摘要、下一计数位）与设备身份逐帧落盘在 `DATA_DIR/sessions/`，帧原件按内容摘要存入 `objects/`，中断后可核对、可续采。

## 目录

`source/` 负责资料源的发布日期、传输状态与本地网关模型；`src/mbus.mjs` 解释 EN 13757 长帧与数据记录；`src/decode.mjs` 给出单帧预览；`src/readout.mjs` 执行领取会话；`src/ledger.mjs` 组合台账与量查询；`src/catalog.mjs` 管理不可变原件及接收凭据；`src/sessions.mjs` 持久化领取进度；`src/app.mjs` 提供查看服务。资料含义及来源控制见 `docs/资料接口.md`。

## 容器

```sh
docker build -t mbus-meter .
docker run --rm --network none mbus-meter
```

镜像固定 Node.js 版本，构建期间不下载 npm 运行依赖。运行产生的原件保存在 `DATA_DIR`，不应写回来源文件。
