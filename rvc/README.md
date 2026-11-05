# 大肥鱼 RVC v2 翻唱模块 (DaFeiYu RVC Singing Pipeline)

基于 RVC v2 (Retrieval-based Voice Conversion) 架构，结合 UVR5 伴奏/干声分离与立体声混音，为大肥鱼赋予真实歌手级别的翻唱与音乐律动能力。

## 目录结构与权重说明

本目录代码已通过 Git 版本控制管理，但体积巨大的模型权重文件（`.pt`、`.pth`、`.index`）与音频文件均已被 `.gitignore` 排除以避免超过 GitHub 100MB 限制。

运行前请确保以下权重已就绪：
- `rvc/hubert_base.pt`: HuBERT 特征提取器底模 (189.5MB)
- `rvc/rmvpe.pt`: RMVPE 音高提取算法底模 (181.2MB)
- `rvc/weights/dafeiyu.pth`: 大肥鱼 RVC v2 训练权重 (55.2MB)
- `rvc/weights/added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index`: 检索索引 (161.9MB)

## 核心脚本

1. `rvc_sing.py`:
   - 核心推理与立体声混音引擎。
   - 内置单次音频上限保护：`MAX_SONG_DURATION = 30.0`（严格限制在 30 秒黄金副歌高潮，保护显存并防止算力长时间占用）。
   - 包含针对 Pascal 显卡 (如 GTX 1080 Ti / fp32 模式) 的自注意力分段显存优化。
2. `download_models.py`:
   - 自动拉取 HuBERT、RMVPE 底模与大肥鱼权重的辅助脚本。
3. `separate_stems.py`:
   - 调用 UVR5 将歌曲原曲分离为人声 (vocal) 与伴奏 (instrument)。
