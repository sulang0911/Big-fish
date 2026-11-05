#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
DaFeiYu (大肥鱼) RVC v2 推理与音乐混音脚本
支持单干声转换、伴奏立体声混音，以及全自动动态点歌流水线（搜索下载 -> UVR5分离 -> RVC转换 -> 混音）。
"""

import os
import sys
import time
import argparse
import subprocess
import re
import hashlib
import numpy as np

# 兼容 Windows 控制台输出编码
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 避免 Windows 下 PyTorch 与 FAISS 的 OpenMP DLL 冲突与内存超限
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:64"

import torch
torch.set_num_threads(2)

import soundfile as sf
import librosa
from rvc_python.infer import RVCInference

RVC_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(RVC_DIR, "weights", "dafeiyu.pth")
DEFAULT_INDEX = "" # 置空以避免 FAISS 加载 160MB 索引导致 8G 内存机器触发 Windows 线程创建内存耗尽
SONGS_DIR = os.path.join(RVC_DIR, "songs")

# 严格时长上限限制：大肥鱼最高只生成 25~30 秒精华片段，严禁整首完整长歌
MAX_SONG_DURATION = 25.0

PRESETS = {
    "qingtian": {
        "title": "晴天 - 周杰伦 (大肥鱼甜美翻唱版)",
        "vocal": os.path.join(SONGS_DIR, "qingtian_vocal.wav"),
        "bgm": os.path.join(SONGS_DIR, "qingtian_instrument.wav"),
        "output": os.path.join(SONGS_DIR, "qingtian_dafeiyu_cover.wav"),
        "f0_up_key": 12,
        "index_rate": 0.75,
        "alias": ["晴天", "qingtian"],
    },
    "qinghuaci": {
        "title": "青花瓷 - 周杰伦 (大肥鱼甜美翻唱版)",
        "vocal": os.path.join(SONGS_DIR, "qinghuaci_vocal.wav"),
        "bgm": os.path.join(SONGS_DIR, "qinghuaci_instrument.wav"),
        "output": os.path.join(SONGS_DIR, "qinghuaci_dafeiyu_cover.wav"),
        "f0_up_key": 12,
        "index_rate": 0.75,
        "alias": ["青花瓷", "qinghuaci"],
    },
    "daoxiang": {
        "title": "稻香 - 周杰伦 (大肥鱼甜美翻唱版)",
        "output": os.path.join(SONGS_DIR, "daoxiang_dafeiyu_cover.wav"),
        "alias": ["稻香", "daoxiang"],
    },
    "yequ": {
        "title": "夜曲 - 周杰伦 (大肥鱼甜美翻唱版)",
        "output": os.path.join(SONGS_DIR, "yequ_dafeiyu_cover.wav"),
        "alias": ["夜曲", "yequ"],
    },
    "gaobaiqiqiu": {
        "title": "告白气球 - 周杰伦 (大肥鱼甜美翻唱版)",
        "output": os.path.join(SONGS_DIR, "gaobaiqiqiu_dafeiyu_cover.wav"),
        "alias": ["告白气球", "gaobaiqiqiu", "情歌"],
    },
    "aini": {
        "title": "爱你 - 王心凌 (大肥鱼原汁萌唱版)",
        "output": os.path.join(SONGS_DIR, "aini_dafeiyu_cover.wav"),
        "alias": ["爱你", "aini", "王心凌"],
    },
}

def detect_auto_key(vocal_path, singer=None):
    """
    智能检测歌曲原唱音高 (F0)：
    - 男声 (< 175 Hz)：自动升 12 个半音 (高八度)，匹配大肥鱼清脆萝莉音区，消除男低音突兀感
    - 女声 (>= 175 Hz)：保持原调 0 半音 (原唱即为女声音域，避免过度升高成花栗鼠)
    """
    try:
        x, _ = librosa.load(vocal_path, sr=16000, duration=10, mono=True)
        if singer and hasattr(singer.rvc.vc, "pipeline") and singer.rvc.vc.pipeline:
            f0, _ = singer.rvc.vc.pipeline.get_f0(vocal_path, x, len(x) // 160, 0, "rmvpe", 3)
            voiced = f0[f0 > 50]
            if len(voiced) > 0:
                med_f0 = float(np.median(voiced))
                print(f"[AUTO_KEY] 探测原唱人声基频 F0 中位数: {med_f0:.1f}Hz")
                if med_f0 < 175:
                    print(f"[AUTO_KEY] 识别为男声原唱 ({med_f0:.1f}Hz < 175Hz)，自动升 12 半音 (+1个八度) 匹配大肥鱼萝莉女声音域！")
                    return 12
                else:
                    print(f"[AUTO_KEY] 识别为女声原唱 ({med_f0:.1f}Hz >= 175Hz)，保持原调 0 半音！")
                    return 0
    except Exception as e:
        print(f"[AUTO_KEY WARN] 音高探测失败，默认升 12 半音: {e}")
    return 12

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
        # 针对 Pascal 显卡 (GTX 1080 Ti 等 fp32 模式) 配置 12~15s 分段，避免长音频自注意力矩阵显存超限
        if hasattr(self.rvc.vc, "pipeline") and self.rvc.vc.pipeline:
            self.rvc.vc.pipeline.x_center = 12
            self.rvc.vc.pipeline.x_max = 15
            self.rvc.vc.pipeline.t_center = 16000 * 12
            self.rvc.vc.pipeline.t_max = 16000 * 15
        print(f"[RVC] 模型加载成功，耗时 {time.time()-t0:.2f}s，目标采样率: {self.rvc.vc.tgt_sr}Hz")

    def convert_vocal(self, input_vocal, output_vocal, f0_up_key=0, f0_method="rmvpe", index_rate=0.75):
        """调用 RVC 转换人声音色 (最高限制 25~30 秒)"""
        v_data, v_sr = sf.read(input_vocal)
        v_duration = len(v_data) / v_sr
        temp_input_trimmed = None
        if v_duration > MAX_SONG_DURATION:
            print(f"[LIMIT] 歌曲时长限制触发: 输入人声 {v_duration:.1f}s > {MAX_SONG_DURATION:.1f}s，自动裁切至 {MAX_SONG_DURATION:.0f} 秒精华片段")
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
        """高质量人声与伴奏立体声混音 (最高限制 25~30 秒)"""
        print(f"[MIX] 开始人声与伴奏混音...")
        print(f"      人声: {vocal_path} (增益: {vocal_gain_db:+.1f}dB)")
        print(f"      伴奏: {bgm_path} (增益: {bgm_gain_db:+.1f}dB)")
        
        vocal_data, vocal_sr = sf.read(vocal_path)
        if vocal_data.ndim > 1:
            vocal_data = np.mean(vocal_data, axis=1)
            
        bgm_data, bgm_sr = sf.read(bgm_path)
        target_sr = bgm_sr
        if vocal_sr != target_sr:
            vocal_data = librosa.resample(vocal_data, orig_sr=vocal_sr, target_sr=target_sr)
            
        if bgm_data.ndim == 1:
            bgm_stereo = np.column_stack([bgm_data, bgm_data])
        else:
            bgm_stereo = bgm_data
            
        vocal_stereo = np.column_stack([vocal_data, vocal_data])
        
        max_samples = int(target_sr * MAX_SONG_DURATION)
        target_len = min(max(len(vocal_stereo), len(bgm_stereo)), max_samples)
        vocal_stereo = vocal_stereo[:target_len]
        bgm_stereo = bgm_stereo[:target_len]
        
        if len(vocal_stereo) < target_len:
            pad = np.zeros((target_len - len(vocal_stereo), 2))
            vocal_stereo = np.vstack([vocal_stereo, pad])
        if len(bgm_stereo) < target_len:
            pad = np.zeros((target_len - len(bgm_stereo), 2))
            bgm_stereo = np.vstack([bgm_stereo, pad])
            
        v_scale = 10.0 ** (vocal_gain_db / 20.0)
        b_scale = 10.0 ** (bgm_gain_db / 20.0)
        mixed = vocal_stereo * v_scale + bgm_stereo * b_scale
        
        peak = np.max(np.abs(mixed))
        if peak > 0.95:
            mixed = mixed * (0.95 / peak)
            print(f"      [LIMITER] 峰值已平滑保护 (原峰值: {peak:.2f} -> 0.95)")
            
        sf.write(output_path, mixed.astype(np.float32), target_sr)
        duration = len(mixed) / target_sr
        print(f"[MIX] 混音生成成功 -> {output_path} (时长: {duration:.1f}s, 采样率: {target_sr}Hz)")
        return output_path

    def sing_song(self, vocal_path, bgm_path=None, output_path=None, f0_up_key=None, index_rate=0.75):
        """完整歌曲处理流程：智能检测原唱音高 -> 转换人声 -> 伴奏混音"""
        if output_path is None:
            output_path = os.path.splitext(vocal_path)[0] + "_dafeiyu.wav"
            
        if f0_up_key is None:
            f0_up_key = detect_auto_key(vocal_path, self)

        temp_vocal = os.path.splitext(output_path)[0] + "_vocal_only.wav"
        self.convert_vocal(vocal_path, temp_vocal, f0_up_key=f0_up_key, index_rate=index_rate)
        
        if bgm_path and os.path.exists(bgm_path):
            self.mix_audio(temp_vocal, bgm_path, output_path)
            if os.path.exists(temp_vocal):
                try:
                    os.remove(temp_vocal)
                except Exception:
                    pass
        else:
            if os.path.exists(output_path):
                os.remove(output_path)
            os.rename(temp_vocal, output_path)
            
        return output_path

def dynamic_sing_flow(song_query):
    """方案 B：全自动点歌流水线（搜索下载 -> 25s副歌切片 -> UVR5独立进程分离 -> RVC翻唱混音 -> 缓存）"""
    query_clean = song_query.strip()
    print(f"\n[*] 启动大肥鱼动态翻唱流水线，请求曲目: {query_clean}")
    
    # 0. 空或泛指点歌处理
    if not query_clean or query_clean in ["随便", "歌", "一首", "来一首", "唱首歌", "唱歌", "听听", "唱歌听听"]:
        fallback_cover = PRESETS["qingtian"]["output"]
        print(f"[PRESET] 命中通用点歌，默认选送经典《晴天》")
        print(f"[OUTPUT_COVER] {fallback_cover}")
        return fallback_cover

    # 1. 优先检查预置歌曲
    for p_key, p_info in PRESETS.items():
        aliases = p_info.get("alias", [p_key])
        if any(a in query_clean for a in aliases) or any(a in query_clean.lower() for a in aliases):
            if os.path.exists(p_info["output"]):
                print(f"[PRESET] 命中预置歌曲《{p_info['title']}》")
                print(f"[OUTPUT_COVER] {p_info['output']}")
                return p_info["output"]

    cache_dir = os.path.join(SONGS_DIR, "cache")
    os.makedirs(cache_dir, exist_ok=True)
    
    # 2. 检查缓存
    safe_name = re.sub(r'[^\w\u4e00-\u9fa5]+', '_', query_clean).strip('_')
    if not safe_name:
        safe_name = hashlib.md5(query_clean.encode()).hexdigest()[:8]
    cached_cover = os.path.join(cache_dir, f"{safe_name}_dafeiyu_cover.wav")
    if os.path.exists(cached_cover):
        print(f"[CACHE] 命中缓存翻唱音频: {cached_cover}")
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
            sid = s.get('id')
            name = s.get('name')
            artist = s.get('artists', [{}])[0].get('name')
            stream = f'http://music.163.com/song/media/outer/url?id={sid}.mp3'
            try:
                resp = requests.get(stream, headers=headers, timeout=8)
                if resp.status_code == 200 and 'audio' in str(resp.headers.get('content-type', '')):
                    temp_mp3 = os.path.join(cache_dir, f"temp_{os.getpid()}_raw.mp3")
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
        print(f"[FALLBACK] 未搜索到《{query_clean}》有效音频，回退至经典抒情歌《晴天》")
        fallback_cover = PRESETS["qingtian"]["output"]
        print(f"[OUTPUT_COVER] {fallback_cover}")
        return fallback_cover

    # 4. 截取 25 秒高潮副歌切片
    temp_clip_wav = os.path.join(cache_dir, f"temp_{os.getpid()}_clip.wav")
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

    # 5. 调用独立 UVR5 进程分离人声与伴奏（子进程彻底隔离内存）
    print("[UVR5] 启动独立子进程分离人声与伴奏...")
    sep_script = os.path.join(RVC_DIR, "separate_stems.py")
    sep_cmd = [sys.executable, sep_script, "--input", temp_clip_wav, "--output_dir", cache_dir]
    sub_res = subprocess.run(sep_cmd, capture_output=True, text=True, timeout=60)
    
    clip_base = os.path.basename(temp_clip_wav)
    vocal_stem = os.path.join(cache_dir, f"vocal_{clip_base}_10.wav")
    inst_stem = os.path.join(cache_dir, f"instrument_{clip_base}_10.wav")

    if not (os.path.exists(vocal_stem) and os.path.exists(inst_stem)):
        print(f"[UVR5 ERROR] {sub_res.stderr}")
        raise RuntimeError("UVR5 音轨分离失败")

    # 6. RVC 转换人声并立体声混音
    singer = DaFeiYuSinger()
    singer.sing_song(vocal_path=vocal_stem, bgm_path=inst_stem, output_path=cached_cover)

    # 7. 清理临时过程文件，仅保留最终 cover
    for f in [downloaded_mp3, temp_clip_wav, vocal_stem, inst_stem]:
        if f and os.path.exists(f):
            try:
                os.remove(f)
            except Exception:
                pass

    print(f"[OUTPUT_COVER] {cached_cover}")
    return cached_cover

def main():
    parser = argparse.ArgumentParser(description="DaFeiYu RVC v2 极简推理混音工具")
    parser.add_argument("--song", type=str, help="全自动搜索、下载、分离并翻唱指定歌曲")
    parser.add_argument("--preset", type=str, choices=list(PRESETS.keys()), help="预置歌曲快捷运行 (qingtian / qinghuaci)")
    parser.add_argument("--vocal", type=str, help="输入人声干声音频路径")
    parser.add_argument("--bgm", type=str, default=None, help="输入伴奏音频路径 (可选)")
    parser.add_argument("--output", type=str, default=None, help="输出最终音频路径")
    parser.add_argument("--key", type=int, default=None, help="升降调半音数 (默认自动检测原唱男/女声)")
    parser.add_argument("--index_rate", type=float, default=0.75, help="检索特征比 (默认 0.75)")
    args = parser.parse_args()

    if args.song:
        dynamic_sing_flow(args.song)
    elif args.preset:
        preset_info = PRESETS[args.preset]
        print(f"\n========================================================")
        print(f"[*] 运行预置示例歌曲: {preset_info['title']}")
        print(f"========================================================")
        if os.path.exists(preset_info["output"]):
            print(f"[PRESET] 预置音频已就绪: {preset_info['output']}")
            print(f"[OUTPUT_COVER] {preset_info['output']}")
        elif "vocal" in preset_info and "bgm" in preset_info:
            singer = DaFeiYuSinger()
            singer.sing_song(
                vocal_path=preset_info["vocal"],
                bgm_path=preset_info["bgm"],
                output_path=preset_info["output"],
                f0_up_key=preset_info.get("f0_up_key", 0),
                index_rate=preset_info.get("index_rate", 0.75)
            )
            print(f"[OUTPUT_COVER] {preset_info['output']}")
        else:
            dynamic_sing_flow(preset_info["title"])
    elif args.vocal:
        singer = DaFeiYuSinger()
        out = singer.sing_song(
            vocal_path=args.vocal,
            bgm_path=args.bgm,
            output_path=args.output,
            f0_up_key=args.key,
            index_rate=args.index_rate
        )
        print(f"[OUTPUT_COVER] {out}")
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
