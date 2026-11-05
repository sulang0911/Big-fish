#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
SO-VITS-SVC 4.1 高保真多音色唱歌翻唱生成器 (纯清唱模式 + 25s上限 + 动态音色自适应同步)
架构升级:
- 多音色模型库: 可莉 (40k高阶)、芙宁娜 (107k高阶)、纳西妲 (40k高阶)、胡桃 (40k高阶)
- 实时音色同步: 动态读取 voice_config.json 或传入 --voice，说话音色与唱歌音色 100% 自动同步
- 独立分音色缓存: 预置曲目与动态抓取歌曲均按音色进行独立缓存，秒级极速直出
- 基频与响度: FCPE 细粒度基频追踪 + 纯清唱 -1.0 dBFS 峰值平滑归一化
"""

import os
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import argparse
import json
import time
import re
import hashlib
import subprocess
import numpy as np
import soundfile as sf
import librosa
import torch

SOVITS_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SOVITS_DIR)
sys.path.insert(0, SOVITS_DIR)

# 限制线程数与内存保护
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:64"

from inference.infer_tool import Svc

MAX_SONG_DURATION = 25.0  # 严格限制最多 25 秒

# 多音色模型配置字典
VOICE_MODELS = {
    "klee": {
        "name": "可莉",
        "model": os.path.join(SOVITS_DIR, "models", "klee_G_40000.pth"),
        "config": os.path.join(SOVITS_DIR, "models", "klee.json"),
        "cluster": os.path.join(SOVITS_DIR, "models", "klee_kmeans_10000.pt"),
        "spk": "klee",
        "cluster_ratio": 0.5,
    },
    "furina": {
        "name": "芙宁娜",
        "model": os.path.join(SOVITS_DIR, "models", "furina_G_107200.pth"),
        "config": os.path.join(SOVITS_DIR, "models", "furina.json"),
        "cluster": "",
        "spk": "fnn",
        "cluster_ratio": 0.0,
    },
    "nahida": {
        "name": "纳西妲",
        "model": os.path.join(SOVITS_DIR, "models", "nahida_G_40000.pth"),
        "config": os.path.join(SOVITS_DIR, "models", "nahida.json"),
        "cluster": os.path.join(SOVITS_DIR, "models", "nahida_kmeans_10000.pt"),
        "spk": "nahida",
        "cluster_ratio": 0.5,
    },
    "hutao": {
        "name": "胡桃",
        "model": os.path.join(SOVITS_DIR, "models", "hutao_G_40000.pth"),
        "config": os.path.join(SOVITS_DIR, "models", "hutao.json"),
        "cluster": os.path.join(SOVITS_DIR, "models", "hutao_kmeans_10000.pt"),
        "spk": "hutao",
        "cluster_ratio": 0.5,
    },
    "barbara": {
        "name": "芭芭拉",
        "model": os.path.join(SOVITS_DIR, "models", "furina_G_107200.pth"),
        "config": os.path.join(SOVITS_DIR, "models", "furina.json"),
        "cluster": "",
        "spk": "fnn",
        "cluster_ratio": 0.0,
    },
    "diona": {
        "name": "迪奥娜",
        "model": os.path.join(SOVITS_DIR, "models", "klee_G_40000.pth"),
        "config": os.path.join(SOVITS_DIR, "models", "klee.json"),
        "cluster": os.path.join(SOVITS_DIR, "models", "klee_kmeans_10000.pt"),
        "spk": "klee",
        "cluster_ratio": 0.5,
    },
}

# 预置歌曲目录
SONGS_DIR = r"D:\deepseek-harness\rvc\songs"
CACHE_DIR = os.path.join(SONGS_DIR, "cache")

PRESETS = {
    "qingtian": {
        "title": "晴天 - 周杰伦",
        "vocal": os.path.join(SONGS_DIR, "qingtian_vocal.wav"),
        "output": os.path.join(SONGS_DIR, "qingtian_dafeiyu_cover.wav"),
        "f0_up_key": 12,
        "alias": ["晴天", "qingtian"],
    },
    "qinghuaci": {
        "title": "青花瓷 - 周杰伦",
        "vocal": os.path.join(SONGS_DIR, "qinghuaci_vocal.wav"),
        "output": os.path.join(SONGS_DIR, "qinghuaci_dafeiyu_cover.wav"),
        "f0_up_key": 12,
        "alias": ["青花瓷", "qinghuaci"],
    },
    "daoxiang": {
        "title": "稻香 - 周杰伦",
        "output": os.path.join(SONGS_DIR, "daoxiang_dafeiyu_cover.wav"),
        "alias": ["稻香", "daoxiang"],
    },
    "yequ": {
        "title": "夜曲 - 周杰伦",
        "output": os.path.join(SONGS_DIR, "yequ_dafeiyu_cover.wav"),
        "alias": ["夜曲", "yequ"],
    },
    "gaobaiqiqiu": {
        "title": "告白气球 - 周杰伦",
        "output": os.path.join(SONGS_DIR, "gaobaiqiqiu_dafeiyu_cover.wav"),
        "alias": ["告白气球", "gaobaiqiqiu", "情歌"],
    },
    "aini": {
        "title": "爱你 - 王心凌",
        "output": os.path.join(SONGS_DIR, "aini_dafeiyu_cover.wav"),
        "alias": ["爱你", "aini", "王心凌"],
    },
}


def get_active_voice_key():
    """读取当前活跃音色配置，未配置时默认 klee"""
    cfg_path = r"D:\deepseek-harness\voice_config.json"
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                return cfg.get("active_voice", "klee")
        except Exception:
            pass
    return "klee"


def detect_key_offset(y, sr):
    """根据输入人声的中位数基频，自适应判断升降调（男声+12，女声0）"""
    try:
        f0 = librosa.yin(y, fmin=65, fmax=500, sr=sr)
        valid_f0 = f0[(f0 > 65) & (f0 < 450)]
        if len(valid_f0) > 0:
            median_f0 = float(np.median(valid_f0))
            if median_f0 < 220.0:
                print(f"[KeyAuto] 检测到原唱为男声 (中位基频 {median_f0:.1f}Hz) -> 升12半音")
                return 12
            else:
                print(f"[KeyAuto] 检测到原唱为女声/童声 (中位基频 {median_f0:.1f}Hz) -> 保持原调 (0半音)")
                return 0
    except Exception as e:
        print(f"[KeyAuto] 音高分析异常 ({e}) -> 默认升12半音")
    return 12


def normalize_vocal(audio_data, target_peak_db=-1.0):
    """峰值平滑归一化至指定 dBFS，防止破音同时保证清唱声音饱满洪亮"""
    peak = np.max(np.abs(audio_data))
    if peak <= 0:
        return audio_data
    target_amp = 10.0 ** (target_peak_db / 20.0)
    gain = target_amp / peak
    return np.clip(audio_data * gain, -1.0, 1.0)


class DaFeiYuSoVitsSinger:
    def __init__(self, voice="klee", model_path=None, config_path=None, cluster_path=None, spk=None, cluster_ratio=None):
        self.voice = str(voice).lower().strip()
        v_info = VOICE_MODELS.get(self.voice, VOICE_MODELS["klee"])

        self.model_path = model_path or v_info["model"]
        self.config_path = config_path or v_info["config"]
        self.cluster_path = cluster_path if cluster_path is not None else v_info["cluster"]
        self.spk = spk or v_info["spk"]
        self.cluster_ratio = v_info["cluster_ratio"] if cluster_ratio is None else float(cluster_ratio)

        if not os.path.exists(self.model_path):
            print(f"[WARN] 音色【{self.voice}】模型文件不存在 ({self.model_path})，自动回退到经典可莉模型")
            v_info = VOICE_MODELS["klee"]
            self.model_path = v_info["model"]
            self.config_path = v_info["config"]
            self.cluster_path = v_info["cluster"]
            self.spk = v_info["spk"]
            self.cluster_ratio = v_info["cluster_ratio"]

        print(f"[SO-VITS] 正在初始化歌声转换引擎 (音色: {self.voice}, spk: {self.spk})...")
        t0 = time.time()
        self.svc = Svc(
            net_g_path=self.model_path,
            config_path=self.config_path,
            cluster_model_path=self.cluster_path if (self.cluster_path and os.path.exists(self.cluster_path)) else "",
        )
        print(f"[SO-VITS] 模型加载完成，耗时 {time.time() - t0:.2f}s, 目标采样率: {self.svc.target_sample}Hz")

    def convert(self, vocal_path, output_path, key_offset="auto", cluster_ratio=None, f0_predictor="fcpe"):
        """将干声转换为当前音色清唱音频"""
        if not os.path.exists(vocal_path):
            raise FileNotFoundError(f"输入音频不存在: {vocal_path}")

        # 1. 读取音频并强制截断至 25.0 秒以内
        y, sr = librosa.load(vocal_path, sr=44100, mono=True)
        max_samples = int(MAX_SONG_DURATION * sr)
        if len(y) > max_samples:
            print(f"[Duration] 输入音频超过 {MAX_SONG_DURATION}s，截断前 {MAX_SONG_DURATION}s")
            y = y[:max_samples]

        # 2. 边缘淡入淡出 (0.05s)
        fade_len = int(0.05 * sr)
        if len(y) > 2 * fade_len:
            y[:fade_len] *= np.linspace(0, 1, fade_len)
            y[-fade_len:] *= np.linspace(1, 0, fade_len)

        # 3. 确定半音偏移量
        if key_offset is None or str(key_offset).lower() == "auto":
            tran = detect_key_offset(y, sr)
        else:
            tran = int(key_offset)
        print(f"[SO-VITS] 变调参数 tran = {tran:+d} 半音 (音色: {self.voice})")

        # 4. 临时保存标准采样率的 wav 供 slice_inference 读取
        temp_input = os.path.join(SOVITS_DIR, f"temp_input_{os.getpid()}.wav")
        sf.write(temp_input, y, sr)

        try:
            ratio = self.cluster_ratio if cluster_ratio is None else float(cluster_ratio)
            kwarg = {
                "raw_audio_path": temp_input,
                "spk": self.spk,
                "tran": tran,
                "slice_db": -40,
                "cluster_infer_ratio": ratio,
                "auto_predict_f0": False,
                "noice_scale": 0.4,
                "pad_seconds": 0.5,
                "clip_seconds": 0,
                "f0_predictor": f0_predictor,
                "loudness_envelope_adjustment": 1.0,
            }
            print(f"[SO-VITS] 开始推理 (音色: {self.voice}, F0预测器: {f0_predictor}, 聚类比: {ratio})...")
            t_infer = time.time()
            audio = self.svc.slice_inference(**kwarg)
            print(f"[SO-VITS] 推理完成，耗时 {time.time() - t_infer:.2f}s")

            # 5. 纯清唱峰值平滑归一化至 -1.0 dBFS
            norm_audio = normalize_vocal(audio, target_peak_db=-1.0)

            # 6. 保存最终翻唱音频
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            sf.write(output_path, norm_audio, self.svc.target_sample)
            print(f"[SUCCESS] 翻唱音频已生成: {output_path} (音色: {self.voice}, 大小: {os.path.getsize(output_path)} 字节)")
            return output_path
        finally:
            if os.path.exists(temp_input):
                try: os.remove(temp_input)
                except: pass
            if torch.cuda.is_available():
                torch.cuda.empty_cache()


def dynamic_sing_flow(song_query, voice=None):
    """
    全自动点歌流水线 (音色同步版):
    1. 自动同步当前音色
    2. 匹配预置歌曲 (秒级直出专属音色翻唱)
    3. 匹配动态缓存 (按歌曲+音色隔离缓存)
    4. 网易云搜索下载 -> 副歌切片 -> UVR5 人声分离 -> SO-VITS-SVC 4.1 清唱转换
    """
    if not voice:
        voice = get_active_voice_key()
    voice = str(voice).lower().strip()
    if voice not in VOICE_MODELS:
        voice = "klee"

    query_clean = song_query.strip().strip("《》\"'").strip()
    
    # 0. 泛指点歌处理
    if not query_clean or query_clean in ["随便", "歌", "一首", "来一首", "唱首歌", "唱歌", "听听", "唱歌听听"]:
        query_clean = "晴天"

    # 1. 优先检查预置歌曲
    for p_key, p_info in PRESETS.items():
        aliases = p_info.get("alias", [p_key])
        if any(a in query_clean for a in aliases) or any(a in query_clean.lower() for a in aliases):
            # 检查当前音色的专属预置翻唱
            voice_preset = os.path.join(SONGS_DIR, f"{p_key}_{voice}_cover.wav")
            if os.path.exists(voice_preset):
                print(f"[PRESET] 命中预置歌曲《{p_info['title']}》（音色: {voice}）")
                print(f"[OUTPUT_COVER] {voice_preset}")
                return voice_preset

            # 若音色是 klee 且默认 cover 存在
            if voice in ["klee", "dafeiyu"] and os.path.exists(p_info.get("output", "")):
                print(f"[PRESET] 命中经典预置歌曲《{p_info['title']}》（音色: {voice}）")
                print(f"[OUTPUT_COVER] {p_info['output']}")
                return p_info["output"]

            # 若存在干声音频，则现场快速生成并缓存该音色版本
            if "vocal" in p_info and os.path.exists(p_info["vocal"]):
                print(f"[PRESET] 命中预置曲目《{p_info['title']}》，正在为音色【{voice}】生成翻唱...")
                singer = DaFeiYuSoVitsSinger(voice=voice)
                singer.convert(vocal_path=p_info["vocal"], output_path=voice_preset, key_offset="auto")
                print(f"[OUTPUT_COVER] {voice_preset}")
                return voice_preset

    os.makedirs(CACHE_DIR, exist_ok=True)
    
    # 2. 检查动态缓存 (包含音色维度)
    safe_name = re.sub(r'[^\w\u4e00-\u9fa5]+', '_', query_clean).strip('_')
    safe_hash = hashlib.md5(f"{query_clean}_{voice}".encode('utf-8', errors='ignore')).hexdigest()[:8]
    cached_cover = os.path.join(CACHE_DIR, f"{safe_name or 'song'}_{safe_hash}_{voice}_cover.wav")
    if os.path.exists(cached_cover):
        print(f"[CACHE] 命中缓存翻唱音频: {cached_cover} (音色: {voice})")
        print(f"[OUTPUT_COVER] {cached_cover}")
        return cached_cover

    # 3. 搜索并下载有效音频
    import requests
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    search_url = 'https://music.163.com/api/search/get/web'
    params = {'s': query_clean, 'type': 1, 'offset': 0, 'limit': 5}
    
    downloaded_mp3 = None
    song_title = query_clean
    try:
        r = requests.get(search_url, params=params, headers=headers, timeout=6)
        songs = r.json().get('result', {}).get('songs', [])
        for s in songs:
            name = s.get('name', '')
            if any(w in name.lower() for w in ['伴奏', 'instrumental', 'inst', 'beat', '伴奏版', '纯音乐']):
                continue
            sid = s.get('id')
            artist = s.get('artists', [{}])[0].get('name')
            stream = f'http://music.163.com/song/media/outer/url?id={sid}.mp3'
            try:
                resp = requests.get(stream, headers=headers, timeout=8)
                if resp.status_code == 200 and 'audio' in str(resp.headers.get('content-type', '')):
                    temp_mp3 = os.path.join(CACHE_DIR, f"temp_{os.getpid()}_raw.mp3")
                    with open(temp_mp3, 'wb') as f:
                        f.write(resp.content)
                    downloaded_mp3 = temp_mp3
                    song_title = f"{name} - {artist}"
                    print(f"[SEARCH] 成功搜索并下载音源: 《{song_title}》")
                    break
            except Exception:
                continue
    except Exception as e:
        print(f"[WARN] 音乐搜索接口异常: {e}")

    if not downloaded_mp3:
        # 回退到对应音色的晴天
        fallback_cover = os.path.join(SONGS_DIR, f"qingtian_{voice}_cover.wav")
        if not os.path.exists(fallback_cover):
            fallback_cover = PRESETS["qingtian"]["output"]
        print(f"[FALLBACK] 未搜索到《{query_clean}》有效音频，回退至经典抒情歌《晴天》（音色: {voice}）")
        print(f"[OUTPUT_COVER] {fallback_cover}")
        return fallback_cover

    # 4. 截取 25 秒高潮副歌切片
    temp_clip_wav = os.path.join(CACHE_DIR, f"temp_{os.getpid()}_clip.wav")
    try:
        y, sr = librosa.load(downloaded_mp3, sr=44100, mono=True)
        total_sec = len(y) / sr
        target_samples = int(MAX_SONG_DURATION * sr)
        if total_sec <= MAX_SONG_DURATION:
            clip = y
        else:
            hop_length = 4410
            rms = librosa.feature.rms(y=y, frame_length=8820, hop_length=hop_length)[0]
            frames_len = int(MAX_SONG_DURATION * sr / hop_length)
            skip_frames = int(15 * sr / hop_length)
            if len(rms) > frames_len + skip_frames:
                search_rms = rms[skip_frames:]
                rolling = np.convolve(search_rms, np.ones(frames_len), mode='valid')
                best_start = skip_frames + int(np.argmax(rolling))
                start_sample = best_start * hop_length
            else:
                start_sample = 0
            clip = y[start_sample : start_sample + target_samples]

        fade_len = int(0.1 * sr)
        if len(clip) > 2 * fade_len:
            clip[:fade_len] *= np.linspace(0, 1, fade_len)
            clip[-fade_len:] *= np.linspace(1, 0, fade_len)

        sf.write(temp_clip_wav, clip, sr)
        print(f"[CLIP] 副歌切片分析完成 (时长: {len(clip)/sr:.1f}s)")
    except Exception as e:
        print(f"[WARN] 切片分析失败，直接使用原音频: {e}")
        temp_clip_wav = downloaded_mp3

    # 5. 调用独立 UVR5 进程分离人声与伴奏
    print("[UVR5] 启动独立子进程分离人声与伴奏...")
    rvc_dir = r"D:\deepseek-harness\rvc"
    sep_script = os.path.join(rvc_dir, "separate_stems.py")
    sep_cmd = [sys.executable, sep_script, "--input", temp_clip_wav, "--output_dir", CACHE_DIR]
    sub_res = subprocess.run(sep_cmd, capture_output=True, text=True, timeout=60)
    
    clip_base = os.path.basename(temp_clip_wav)
    vocal_stem = os.path.join(CACHE_DIR, f"vocal_{clip_base}_10.wav")
    inst_stem = os.path.join(CACHE_DIR, f"instrument_{clip_base}_10.wav")

    if not (os.path.exists(vocal_stem) and os.path.exists(inst_stem)):
        print(f"[UVR5 ERROR] {sub_res.stderr}")
        raise RuntimeError("UVR5 音轨分离失败")

    # 6. SO-VITS-SVC 4.1 高保真转换 (纯清唱模式，使用当前同步音色)
    singer = DaFeiYuSoVitsSinger(voice=voice)
    singer.convert(vocal_path=vocal_stem, output_path=cached_cover, key_offset="auto")

    # 7. 清理临时过程文件，仅保留最终 cover
    for f in [downloaded_mp3, temp_clip_wav, vocal_stem, inst_stem]:
        if f and os.path.exists(f):
            try: os.remove(f)
            except Exception: pass

    print(f"[OUTPUT_COVER] {cached_cover}")
    return cached_cover


def main():
    parser = argparse.ArgumentParser(description="SO-VITS-SVC 4.1 大肥鱼高保真多音色唱歌翻唱工具")
    parser.add_argument("--song", type=str, help="全自动搜索、下载、分离并翻唱指定歌曲")
    parser.add_argument("--voice", type=str, default=None, help="目标音色 (klee/furina/nahida/hutao/barbara/diona)")
    parser.add_argument("--vocal", help="输入的干声音频路径")
    parser.add_argument("--output", help="输出的翻唱音频路径")
    parser.add_argument("--key", default="auto", help="变调半音数 (如 12, 0, -12, auto)")
    parser.add_argument("--cluster-ratio", type=float, default=None, help="聚类模型融合比 (0.0~1.0)")
    parser.add_argument("--f0-predictor", default="fcpe", choices=["fcpe", "pm", "crepe", "dio", "harvest"], help="F0 预测器")

    args = parser.parse_args()

    if args.song:
        dynamic_sing_flow(args.song, voice=args.voice)
    elif args.vocal and args.output:
        singer = DaFeiYuSoVitsSinger(voice=args.voice or "klee")
        singer.convert(
            vocal_path=args.vocal,
            output_path=args.output,
            key_offset=args.key,
            cluster_ratio=args.cluster_ratio,
            f0_predictor=args.f0_predictor,
        )
        print(f"[OUTPUT_COVER] {args.output}")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
