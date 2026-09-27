# 井字棋（Tic-Tac-Toe）

最小可玩示例：展示"规则包 + 脑脚本 + headless 对局"的完整形状。
新游戏照这个目录结构抄一份即可：`rules.js`、`tuning.json`、`brains/*.js`、
`demo.py`、`README.md`。

```
examples/tictactoe/
  manifest.json       # 包自描述：名称 + 能力（blocker/random 都不申请 llm/jev/svc）
  rules.js            # newmatch / tick / snapshot / over（单参数对象签名）
  tuning.json         # 调参（本游戏无数值，仅占位保持包形状）
  brains/
    random.js         # 首个空格子，基线
    blocker.js        # 能赢则赢、能堵则堵、否则中角边
  ui/board/
    index.html        # 单文件人机对战页
  demo.py             # 上传包 → headless AI-vs-AI → 打印棋盘
```

## 跑

```bash
# 网关需开 admin（设 ADMIN_TOKEN），games 走 admin-token 鉴权
python3 examples/tictactoe/demo.py --base http://localhost:8080 --token $ADMIN_TOKEN
python3 examples/tictactoe/demo.py --x blocker --o blocker   # 互堵，应为 draw
```

规则要点：X 走 p0 槽、O 走 p1 槽，每 tick 只走轮到的一方；
非法落子记 `illegal` 事件且不换手；胜负/和棋即 `over`，对局卸载只留战报。
人类命令每 tick 消费一次，不重放。

## 前端

`ui/board/index.html` 单文件人机对战页，网关同源托管（无跨域）：

```bash
# 打开 http://网关:端口/play/tictactoe/       # 单变体 302 直达 /play/tictactoe/board/
# 选 AI 脑与先后手 → 开局 → 点格落子，SSE 自动刷新 AI 走子
```

页面调 `POST /v1/games`（`{human:true}` 槽 + 脑槽）、`POST .../commands` 落子、
`GET .../events`（SSE，token 走 `?token=`）刷新。
