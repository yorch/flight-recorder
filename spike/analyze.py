#!/usr/bin/env python3
"""Analyze spike artifacts. Usage: python3 spike/analyze.py [results_dir]

Requires ffmpeg/ffprobe on PATH. Writes <results_dir>/analysis.json and prints a summary.
Color sampling uses a small crop at the viewport center (away from the click target,
the cursor decoration and the action-title overlay) and classifies by YUV averages.
"""
import csv
import json
import re
import statistics
import subprocess
import sys
from pathlib import Path

REGION = "crop=iw*0.06:ih*0.06:iw*0.47:ih*0.47"
MATCH_WINDOW_S = 0.35  # clicks are 700 ms apart


def jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def classify(y, u, v):
    if v > 190:
        return "red"
    if v < 90 and u < 100:
        return "green"
    if y > 200 and 110 < v < 150:
        return "white"
    return "other"


def signal(source):
    """Per-frame (pts_time, class, Y, U, V) for the sample region of `source` (a lavfi movie= path)."""
    out = run([
        "ffprobe", "-v", "error", "-f", "lavfi", "-i", f"movie={source},{REGION},signalstats",
        "-show_entries", "frame=pts_time:frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.UAVG,lavfi.signalstats.VAVG",
        "-of", "json",
    ]).stdout
    rows = []
    for f in json.loads(out)["frames"]:
        if f.get("pts_time") in (None, "N/A"):
            continue
        t = f["tags"]
        y, u, v = (float(t[f"lavfi.signalstats.{k}AVG"]) for k in "YUV")
        rows.append((float(f["pts_time"]), classify(y, u, v), y, u, v))
    return rows


def transitions(rows):
    """Times of the first frame showing a new red/white state."""
    out, prev = [], None
    for t, c, *_ in rows:
        if c not in ("red", "white"):
            continue
        if prev is not None and c != prev:
            out.append((t, c))
        prev = c
    return out


def stats(values):
    if not values:
        return None
    s = sorted(values)
    return {
        "n": len(s),
        "min": round(s[0], 2),
        "median": round(statistics.median(s), 2),
        "p90": round(s[min(len(s) - 1, int(0.9 * len(s)))], 2),
        "max": round(s[-1], 2),
        "mean": round(statistics.fmean(s), 2),
        "stdev": round(statistics.stdev(s), 2) if len(s) > 1 else 0.0,
    }


def match(clicks, trans, to_video_s):
    """For each click, the first transition to its expected color within the window after the click."""
    out = []
    for c in clicks:
        tv = to_video_s(c["page_click_ms"])
        cands = [t for t, color in trans if color == c["color_after"] and tv - MATCH_WINDOW_S <= t <= tv + MATCH_WINDOW_S]
        out.append((c, min(cands, key=lambda t: abs(t - tv)) if cands else None))
    return out


def video_info(path):
    out = run([
        "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height,avg_frame_rate,nb_read_frames:format=duration",
        "-of", "json", str(path),
    ]).stdout
    d = json.loads(out)
    s = d["streams"][0]
    return {
        "codec": s.get("codec_name"),
        "size": f'{s.get("width")}x{s.get("height")}',
        "avg_frame_rate": s.get("avg_frame_rate"),
        "frames": int(s.get("nb_read_frames", 0) or 0),
        "duration_s": float(d.get("format", {}).get("duration", "nan")),
    }


def distinct_frames(path, start, end):
    out = run([
        "ffprobe", "-v", "error", "-f", "lavfi",
        "-i", f"movie={path},trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS,mpdecimate",
        "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0",
    ]).stdout.strip()
    total = run([
        "ffprobe", "-v", "error", "-f", "lavfi",
        "-i", f"movie={path},trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS",
        "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0",
    ]).stdout.strip()
    dur = end - start
    return {"window_s": round(dur, 3), "frames": int(total), "distinct": int(out), "distinct_fps": round(int(out) / dur, 2)}


def image_compare(a, b, scale_both=True):
    vf = "[0:v]scale=1920:1080:flags=bicubic,format=yuv420p[a];[1:v]scale=1920:1080:flags=bicubic,format=yuv420p[b]" if scale_both else "[0:v]format=yuv420p[a];[1:v]format=yuv420p[b]"
    ssim = run(["ffmpeg", "-v", "info", "-i", str(a), "-i", str(b), "-lavfi", f"{vf};[a][b]ssim", "-f", "null", "-"]).stderr
    psnr = run(["ffmpeg", "-v", "info", "-i", str(a), "-i", str(b), "-lavfi", f"{vf};[a][b]psnr", "-f", "null", "-"]).stderr
    s = re.search(r"All:([\d.]+)", ssim)
    p = re.search(r"average:([\d.]+|inf)", psnr)
    return {"ssim": float(s.group(1)) if s else None, "psnr_db": p.group(1) if p else None}


def segment(events, name):
    start = next((e["t_ms"] for e in events if e["type"] == "SEGMENT_START" and e["name"] == name), None)
    end = next((e["t_ms"] for e in events if e["type"] == "SEGMENT_END" and e["name"] == name), None)
    return start, end


def docker_stats(path):
    if not Path(path).exists():
        return None
    per = {}
    with open(path) as f:
        for row in csv.DictReader(f):
            cpu = float(row["cpu_perc"].rstrip("%") or 0)
            mem = row["mem_usage"].split("/")[0].strip()
            m = re.match(r"([\d.]+)\s*([KMG]i?B)", mem)
            mib = float(m.group(1)) * {"KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "KB": 1 / 1024, "MB": 1, "GB": 1024}[m.group(2)] if m else 0
            per.setdefault(row["container"], {"cpu": [], "mem": []})
            per[row["container"]]["cpu"].append(cpu)
            per[row["container"]]["mem"].append(mib)
    return {k: {"cpu_mean_pct": round(statistics.fmean(v["cpu"]), 1), "cpu_max_pct": round(max(v["cpu"]), 1),
                "mem_max_mib": round(max(v["mem"]), 1)} for k, v in per.items()}


def fraction(rows, start_s, end_s, cls):
    window = [c for t, c, *_ in rows if start_s <= t <= end_s]
    return {"frames": len(window), cls: round(sum(c == cls for c in window) / len(window), 3) if window else None}


def analyze_a(d):
    ev = jsonl(d / "events.jsonl")
    video = d / "video.mkv"
    v0 = next(e["video_start_ms"] for e in ev if e["type"] == "RECORDING_START")
    to_v = lambda ms: (ms - v0) / 1000
    rows = signal(video)
    trans = transitions(rows)
    res = {"video": video_info(video), "transitions_found": len(trans), "sync": {}}
    for seg in ("sync_cdp", "sync_os"):
        clicks = [e for e in ev if e["type"] == "PAGE_CLICK" and e["segment"] == seg]
        if not clicks:
            continue
        m = match(clicks, trans, to_v)
        res["sync"][seg] = {
            "matched": sum(t is not None for _, t in m),
            "clicks": len(clicks),
            "latency_vs_page_click_ms": stats([v0 + t * 1000 - c["page_click_ms"] for c, t in m if t is not None]),
            "latency_vs_page_raf_ms": stats([v0 + t * 1000 - c["page_raf_ms"] for c, t in m if t is not None]),
        }
    a0, a1 = segment(ev, "anim")
    res["anim"] = distinct_frames(video, to_v(a0), to_v(a1))
    q0, q1 = segment(ev, "quality")
    frame = d / "_quality_frame.png"
    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{to_v((q0 + q1) / 2):.3f}", "-i", str(video), "-frames:v", "1", str(frame)])
    res["quality_vs_screenshot"] = image_compare(frame, d / "quality.png")
    p0, p1 = segment(ev, "popup")
    res["popup_green"] = fraction(rows, to_v(p0) + 0.8, to_v(p1) - 0.6, "green")
    return res


def analyze_b(d):
    ev = jsonl(d / "events.jsonl")
    video = d / "video.webm"
    frames = jsonl(d / "frames.jsonl")
    res = {"video": video_info(video), "frames_jsonl": len(frames)}

    rows = signal(video)
    vtrans = transitions(rows)
    res["video_transitions_found"] = len(vtrans)

    jpgs = []
    for p in sorted((d / "frames").glob("*.jpg")):
        m = re.match(r"(\d+)_([\d.]+)\.jpg$", p.name)
        if not m:
            continue
        r = signal(p)
        if r:
            jpgs.append((float(m.group(2)), r[0][1]))
    jpgs.sort()
    jtrans, prev = [], None
    for ts, c in jpgs:
        if c not in ("red", "white"):
            continue
        if prev is not None and c != prev:
            jtrans.append((ts, c))
        prev = c
    res["jpeg_frames"] = len(jpgs)
    res["jpeg_transitions_found"] = len(jtrans)

    clicks = [e for e in ev if e["type"] == "PAGE_CLICK" and e["segment"] == "sync_cdp"]
    first_ts = frames[0]["timestamp"] if frames else None
    rec = next(e for e in ev if e["type"] == "RECORDING_START")
    res["first_frame_ts_minus_record_start_ms"] = round(first_ts - rec["t_ms"], 2) if first_ts else None

    # Presentation latency from Playwright's own frame timestamps (no video involved).
    jm = []
    for c in clicks:
        cands = [ts for ts, color in jtrans if color == c["color_after"] and c["page_click_ms"] - MATCH_WINDOW_S * 1000 <= ts <= c["page_click_ms"] + MATCH_WINDOW_S * 1000]
        jm.append((c, min(cands, key=lambda ts: abs(ts - c["page_click_ms"])) if cands else None))
    res["frame_ts_latency_vs_page_click_ms"] = stats([ts - c["page_click_ms"] for c, ts in jm if ts is not None])
    res["frame_ts_latency_vs_page_raf_ms"] = stats([ts - c["page_raf_ms"] for c, ts in jm if ts is not None])

    # Video timeline mapping: hypothesis video t=0 == first onFrame timestamp; measure residual per click.
    if first_ts is not None:
        vm = match(clicks, vtrans, lambda ms: (ms - first_ts) / 1000)
        res["video_latency_vs_page_click_ms_assuming_t0_first_frame"] = stats([first_ts + t * 1000 - c["page_click_ms"] for c, t in vm if t is not None])
        pairs = [(t, ts) for (c, t), (_, ts) in zip(vm, jm) if t is not None and ts is not None]
        offsets = [ts - t * 1000 for t, ts in pairs]
        res["offset_jpeg_ts_minus_video_t_ms"] = stats([o - first_ts for o in offsets])
        if len(pairs) >= 3:
            xs, ys = [t for t, _ in pairs], [ts / 1000 for _, ts in pairs]
            mx, my = statistics.fmean(xs), statistics.fmean(ys)
            res["drift_slope_frame_s_per_video_s"] = round(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs), 5)

    # Frame cadence per segment from onFrame timestamps.
    cad = {}
    for seg in ("sync_cdp", "anim", "quality", "popup"):
        s0, s1 = segment(ev, seg)
        ts = [f["timestamp"] for f in frames if s0 is not None and s0 <= f["timestamp"] <= s1]
        iv = [b - a for a, b in zip(ts, ts[1:])]
        cad[seg] = {"frames": len(ts), "fps": round(len(ts) / ((s1 - s0) / 1000), 2) if s0 else None, "interval_ms": stats(iv)}
    res["onframe_cadence"] = cad
    res["onframe_delivery_lag_ms"] = stats([f["recv_ms"] - f["timestamp"] for f in frames])
    res["onframe_viewport_sizes"] = sorted({f'{f["viewportWidth"]}x{f["viewportHeight"]}' for f in frames})

    if first_ts is not None:
        to_v = lambda ms: (ms - first_ts) / 1000
        a0, a1 = segment(ev, "anim")
        res["anim"] = distinct_frames(video, to_v(a0), to_v(a1))
        q0, q1 = segment(ev, "quality")
        frame = d / "_quality_frame.png"
        run(["ffmpeg", "-v", "error", "-y", "-ss", f"{to_v((q0 + q1) / 2):.3f}", "-i", str(video), "-frames:v", "1", str(frame)])
        res["quality_vs_screenshot"] = image_compare(frame, d / "quality.png")
        p0, p1 = segment(ev, "popup")
        res["popup_green"] = fraction(rows, to_v(p0) + 0.8, to_v(p1) - 0.6, "green")

    if (d / "decor_on.png").exists() and (d / "decor_off.png").exists():
        res["decor_on_vs_off"] = image_compare(d / "decor_on.png", d / "decor_off.png", scale_both=False)
    for name in ("aria_before.txt", "aria_after.txt"):
        p = d / name
        res[f"{name}_lines"] = len(p.read_text().splitlines()) if p.exists() else None
    if (d / "aria_before.txt").exists() and (d / "aria_after.txt").exists():
        res["aria_identical"] = (d / "aria_before.txt").read_text() == (d / "aria_after.txt").read_text()
    return res


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "results")
    out = {}
    for arm, fn in (("a", analyze_a), ("b", analyze_b)):
        d = root / arm
        if not d.exists():
            out[arm] = {"error": "missing"}
            continue
        try:
            out[arm] = fn(d)
        except Exception as e:  # report and continue with the other arm
            out[arm] = {"error": f"{type(e).__name__}: {e}"}
        out[arm]["docker_stats"] = docker_stats(d / "stats.csv")
        for name in ("checks.json", "timings.json"):
            p = d / name
            out[arm][name] = json.loads(p.read_text()) if p.exists() else None
    (root / "analysis.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
