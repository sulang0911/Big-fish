#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
DaFeiYu (大肥鱼) RVC v2 推理与音乐混音脚本
支持单干声转换，以及干声转换 + 伴奏对齐混合生成完整 AI 翻唱歌曲。
"""

import os
import sys
import time
import argparse
import numpy as np

# 兼容 Windows 控制台输出编码
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 避免 Windows 下 PyTorch 与 FAISS 的 OpenMP DLL 冲突
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

import soundfile as sf
import librosa
from rvc_python.infer import RVCInference

RVC_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(RVC_DIR, "weights", "dafeiyu.pth")
DEFAULT_INDEX = os.path.join(RVC_DIR, "weights", "added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index")
SONGS_DIR = os.path.join(RVC_DIR, "songs")

# 严格时长上限限制：大肥鱼最高只生成 30 秒精华片段，严禁整首完整长歌
MAX_SONG_DURATION = 30.0

PRESETS = {
    "qingtian": {
        "title": "晴天 - 周杰伦 (大肥鱼翻唱版)",
        "vocal": os.path.join(SONGS_DIR, "qingtian_vocal.wav"),
        "bgm": os.path.join(SONGS_DIR, "qingtian_instrument.wav"),
        "output": os.path.join(SONGS_DIR, "qingtian_dafeiyu_cover.wav"),
        "f0_up_key": 0,
        "index_rate": 0.75,
    },
    "qinghuaci": {
        "title": "青花瓷 - 周杰伦 (大肥鱼翻唱版)",
        "vocal": os.path.join(SONGS_DIR, "qinghuaci_vocal.wav"),
        "bgm": os.path.join(SONGS_DIR, "qinghuaci_instrument.wav"),
        "output": os.path.join(SONGS_DIR, "qinghuaci_dafeiyu_cover.wav"),
        "f0_up_key": 0,
        "index_rate": 0.75,
    }
}

class DaFeiYuSinger:
    def __init__(self, model_path=DEFAULT_MODEL, index_path=DEFAULT_INDEX, device="cuda:0"):
        self.device = device
        self.model_path = model_path
        self.index_path = index_path if os.path.exists(index_path) else ""
        
        print(f"[RVC] 初始化大肥鱼 RVC 推理引擎 (设备: {self.device})...")
        t0 = time.time()
        self.rvc = RVCInference(
            device=self.device,
            model_path=self.model_path,
            index_path=self.index_path,
            version="v2"
        )
        # 针对 Pascal 显卡 (GTX 1080 Ti 等 fp32 模式) 配置 15s 分段，避免长音频自注意力矩阵显存超限
        if hasattr(self.rvc.vc, "pipeline") and self.rvc.vc.pipeline:
            self.rvc.vc.pipeline.x_center = 15
            self.rvc.vc.pipeline.x_max = 18
            self.rvc.vc.pipeline.t_center = 16000 * 15
            self.rvc.vc.pipeline.t_max = 16000 * 18
        print(f"[RVC] 模型加载成功，耗时 {time.time()-t0:.2f}s，目标采样率: {self.rvc.vc.tgt_sr}Hz")

    def convert_vocal(self, input_vocal, output_vocal, f0_up_key=0, f0_method="rmvpe", index_rate=0.75):
        """调用 RVC 转换人声音色 (最高限制 30 秒)"""
        # 前置时长检查与自动裁切至 30s
        v_data, v_sr = sf.read(input_vocal)
        v_duration = len(v_data) / v_sr
        temp_input_trimmed = None
        if v_duration > MAX_SONG_DURATION:
            print(f"[LIMIT] 歌曲时长限制触发: 输入人声 {v_duration:.1f}s > {MAX_SONG_DURATION:.1f}s，自动裁切至 30 秒精华片段")
            v_data = v_data[: int(v_sr * MAX_SONG_DURATION)]
            temp_input_trimmed = os.path.splitext(output_vocal)[0] + "_input_trimmed.wav"
            sf.write(temp_input_trimmed, v_data, v_sr)
            actual_input = temp_input_trimmed
        else:
            actual_input = input_vocal

        print(f"[RVC] 正在转换人声: {actual_input}")
        print(f"      参数: 变调={f0_up_key}半音, 算法={f0_method}, 检索特征比={index_rate}")
        t0 = time.time()
        
        self.rvc.set_params(
            f0method=f0_method,
            f0up_key=f0_up_key,
            index_rate=index_rate,
            filter_radius=3,
            rms_mix_rate=1.0,
            protect=0.33
        )
        
        self.rvc.infer_file(actual_input, output_vocal)
        if temp_input_trimmed and os.path.exists(temp_input_trimmed):
            try:
                os.remove(temp_input_trimmed)
            except Exception:
                pass
        print(f"[RVC] 人声转换完成 -> {output_vocal}，耗时 {time.time()-t0:.2f}s")
        return output_vocal

    @staticmethod
    def mix_audio(vocal_path, bgm_path, output_path, vocal_gain_db=1.0, bgm_gain_db=-1.0):
        """高质量人声与伴奏立体声混音 (最高限制 30 秒)"""
        print(f"[MIX] 开始人声与伴奏混音...")
        print(f"      人声: {vocal_path} (增益: {vocal_gain_db:+.1f}dB)")
        print(f"      伴奏: {bgm_path} (增益: {bgm_gain_db:+.1f}dB)")
        
        # 读取人声 (通常 RVC 输出为 40kHz 单声道)
        vocal_data, vocal_sr = sf.read(vocal_path)
        if vocal_data.ndim > 1:
            vocal_data = np.mean(vocal_data, axis=1)
            
        # 读取伴奏
        bgm_data, bgm_sr = sf.read(bgm_path)
        
        # 统一采样率至伴奏采样率 (通常 44.1kHz 或 48kHz)
        target_sr = bgm_sr
        if vocal_sr != target_sr:
            vocal_data = librosa.resample(vocal_data, orig_sr=vocal_sr, target_sr=target_sr)
            
        # 伴奏转立体声 (N, 2)
        if bgm_data.ndim == 1:
            bgm_stereo = np.column_stack([bgm_data, bgm_data])
        else:
            bgm_stereo = bgm_data
            
        # 人声转立体声
        vocal_stereo = np.column_stack([vocal_data, vocal_data])
        
        # 对齐长度并限制最大时长不超过 MAX_SONG_DURATION (30s)
        max_samples = int(target_sr * MAX_SONG_DURATION)
        target_len = min(max(len(vocal_stereo), len(bgm_stereo)), max_samples)
        vocal_stereo = vocal_stereo[:target_len]
        bgm_stereo = bgm_stereo[:target_len]
        
        # 补齐长度
        if len(vocal_stereo) < target_len:
            pad = np.zeros((target_len - len(vocal_stereo), 2))
            vocal_stereo = np.vstack([vocal_stereo, pad])
        if len(bgm_stereo) < target_len:
            pad = np.zeros((target_len - len(bgm_stereo), 2))
            bgm_stereo = np.vstack([bgm_stereo, pad])
            
        # 计算音量增益
        v_scale = 10.0 ** (vocal_gain_db / 20.0)
        b_scale = 10.0 ** (bgm_gain_db / 20.0)
        
        # 混音
        mixed = vocal_stereo * v_scale + bgm_stereo * b_scale
        
        # 峰值软限幅与归一化（防止爆音）
        peak = np.max(np.abs(mixed))
        if peak > 0.95:
            mixed = mixed * (0.95 / peak)
            print(f"      [LIMITER] 峰值已平滑保护 (原峰值: {peak:.2f} -> 0.95)")
            
        # 保存输出
        sf.write(output_path, mixed.astype(np.float32), target_sr)
        duration = len(mixed) / target_sr
        print(f"[MIX] 混音生成成功 -> {output_path} (时长: {duration:.1f}s, 采样率: {target_sr}Hz)")
        return output_path

    def sing_song(self, vocal_path, bgm_path=None, output_path=None, f0_up_key=0, index_rate=0.75):
        """完整歌曲处理流程：转换人声 -> 伴奏混音"""
        if output_path is None:
            output_path = os.path.splitext(vocal_path)[0] + "_dafeiyu.wav"
            
        temp_vocal = os.path.splitext(output_path)[0] + "_vocal_only.wav"
        
        # 1. 转换人声
        self.convert_vocal(vocal_path, temp_vocal, f0_up_key=f0_up_key, index_rate=index_rate)
        
        # 2. 如果提供了伴奏，则执行高质量立体声混音
        if bgm_path and os.path.exists(bgm_path):
            self.mix_audio(temp_vocal, bgm_path, output_path)
        else:
            if os.path.exists(output_path):
                os.remove(output_path)
            os.rename(temp_vocal, output_path)
            
        return output_path

def main():
    parser = argparse.ArgumentParser(description="DaFeiYu RVC v2 极简推理混音工具")
    parser.add_argument("--preset", type=str, choices=list(PRESETS.keys()), help="预置歌曲快捷运行 (qingtian / qinghuaci)")
    parser.add_argument("--vocal", type=str, help="输入人声干声音频路径")
    parser.add_argument("--bgm", type=str, default=None, help="输入伴奏音频路径 (可选)")
    parser.add_argument("--output", type=str, default=None, help="输出最终音频路径")
    parser.add_argument("--key", type=int, default=0, help="升降调半音数 (默认 0)")
    parser.add_argument("--index_rate", type=float, default=0.75, help="检索特征比 (默认 0.75)")
    args = parser.parse_args()

    singer = DaFeiYuSinger()

    if args.preset:
        preset_info = PRESETS[args.preset]
        print(f"\n========================================================")
        print(f"[*] 运行预置示例歌曲: {preset_info['title']}")
        print(f"========================================================")
        singer.sing_song(
            vocal_path=preset_info["vocal"],
            bgm_path=preset_info["bgm"],
            output_path=preset_info["output"],
            f0_up_key=preset_info["f0_up_key"],
            index_rate=preset_info["index_rate"]
        )
    elif args.vocal:
        singer.sing_song(
            vocal_path=args.vocal,
            bgm_path=args.bgm,
            output_path=args.output,
            f0_up_key=args.key,
            index_rate=args.index_rate
        )
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
