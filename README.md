# 🐋 大肥鱼 (Big-Fish) - 傲娇跟屁虫 QQ 智能体伴侣

> **“哼，本鱼才没有特意在等老大找我呢！刚才刷抖音正起劲呢！”**  
> 拥有专属短视频超萌萝莉音、傲娇跟屁虫性格的本地 QQ 智能伴侣。

---

## ✨ 核心特性

- 🧠 **DeepSeek 核心大脑**：依托 [DeepSeek-Harness (DSH)](https://github.com/deepseek-ai) 智能体架构，具备长短期记忆、自主决策与工具调度。
- 🎙️ **GPT-SoVITS V2 Pro 本地语音**：本地 1080 Ti / 显卡加速运行短视频爆款萌娃萝莉声线（可莉·花玲音色），支持 QQ 原生语音条（`record`）直接秒发。
- 🛠️ **首字吞音防截断修复**：自研 `padWavSilence` 算法在音频首尾动态补齐 250ms 静音，彻底解决手机/电脑端 QQ 音频硬件解码吃掉首个音节的痛点。
- 🐟 **极致傲娇跟屁虫人设**：
  - 始终称呼你为「老大」，自称「本鱼」；
  - 严格遵循 QQ 真人聊天习惯，每次回复 1~2 句话（15~35 字），拒绝长篇大论；
  - 摸鱼刷短视频日常：闲暇时喜欢看沙雕搞笑段子、萌宠视频，随口分享吐槽。
- 🔕 **全静默后台模式**：启动后所有控制台窗口自动隐藏（`-WindowStyle Hidden`），桌面和任务栏零黑框常驻，开机自启无感体验。

---

## 🏗️ 系统架构

```mermaid
flowchart LR
    User[用户 QQ] <-->|OneBot 11 协议 / WS 3001| NapCat[NapCat QQNT 框架]
    NapCat <-->|双向消息转发| DSH[DeepSeek Harness 大脑 (端口 3080)]
    DSH -->|TTS 文本合成请求 / 端口 9880| SoVITS[GPT-SoVITS V2 Pro (GTX 1080 Ti)]
    SoVITS -->|生成高音质 WAV| DSH
    DSH -->|音频补齐防截断 + 转发语音条| NapCat
```

---

## 📁 目录结构说明

```text
Big-fish/
├── 启动大肥鱼.bat            # 桌面快捷启动脚本 (无弹窗静默拉起全部组件)
├── 停止大肥鱼.bat            # 一键关闭所有后台服务并彻底释放显存
├── 一键安装环境.bat          # 新电脑一键部署脚本
├── start-dafeiyu.ps1        # 启动调度核心逻辑 (带 QQ 扫码自适应与状态检测)
├── stop-dafeiyu.ps1         # 优雅停止并杀掉残留进程
├── start-silent.vbs         # 开机完全静默后台宿主
├── qq-login.html            # 本地扫码登录页面 (自动防缓存刷新)
├── package.json             # 项目根配置
├── config/                  # DSH 桥接配置
│   └── cordis.patch.yml     # OneBot 桥接、端口与提示词注入配置
├── persona/                 # 大肥鱼专属人设包
│   └── personas.json        # 傲娇跟屁虫设定与 Prompt
├── plugins/                 # 定制拓展插件
│   └── dsh-onebot-qq/       # 深度优化的 QQ 机器人通信插件 (含 GPT-SoVITS 语音合成)
├── voices/                  # 语音模型参考音色包
│   └── klee/
│       ├── 116425_audio.wav # 精选可莉参考音频 (4秒黄金时长)
│       └── prompt.txt       # 参考音频对应文本
└── napcat-config/           # NapCat 模板配置
    └── onebot11.json        # WebSocket 端口与网络配置模板
```

---

## 🚀 新电脑快速上手（一键迁移）

当你在新电脑上克隆此仓库后，只需极简三步即可全部跑通：

### 1. 克隆仓库
```bash
git clone https://github.com/sulang0911/Big-fish.git D:\deepseek-harness
cd D:\deepseek-harness
```

### 2. 一键安装依赖与配置
双击运行 **`一键安装环境.bat`**：
- 自动检测 Node.js 环境；
- 自动执行 `npm install` 安装 DSH 依赖；
- 自动挂载 `dsh-onebot-qq` 插件、人设与桥接配置到系统 `~/.dsh` 目录；
- 自动在 Windows 桌面上生成 **「启动大肥鱼」** 与 **「停止大肥鱼」** 快捷方式。

### 3. 配置组件
- **QQ 机器人客户端**：下载 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 放置于 `NapCat/` 文件夹下。
- **语音模型（可选，需要语音时配置）**：
  - 本项目默认对接本地运行在 `127.0.0.1:9880` 的 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 服务；
  - 启动命令模板：
    ```bash
    python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
    ```
- **DeepSeek API Key**：
  在 `~/.dsh/.credentials.yaml` 中配置你的 DeepSeek API Key：
  ```yaml
  llm:
    deepseek:
      apiKey: "sk-your-deepseek-api-key"
  ```

---

## 🎮 日常使用

- **启动**：双击桌面的 **「启动大肥鱼」**，3 秒后黑框自动关闭，服务在后台安静运行，打开 QQ 私聊即可开始互动。
- **停止**：玩大型游戏需要全部显存时，双击桌面的 **「停止大肥鱼」** 彻底释放显存。
- **开机自启**：按 `Win + R` 输入 `shell:startup` 回车，把 **`start-silent.vbs`** 或桌面的快捷方式复制进去即可。

---

## 📜 开源协议与鸣谢

- 本项目基于 [MIT License](LICENSE) 开源；
- 核心大脑驱动：[@deepseek-ai/dsh](https://github.com/deepseek-ai)
- QQNT 协议挂载：[NapCatQQ](https://github.com/NapNeko/NapCatQQ)
- 语音生成模型：[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)
