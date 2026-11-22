#!/usr/bin/env python3
"""Turn a captured ANSI stream into the README's animated demos.

`capture.ts` records what the real Dashboard painted, with a timestamp per
write. This script replays that stream through a small terminal emulator (SGR
colour, erase, cursor movement — the subset Ink actually emits) and renders the
screen at a fixed frame rate with a monospace font, then writes:

    docs/media/<demo>.gif     the README asset
    docs/media/<demo>.mp4     the same run for video-first channels (ffmpeg)
    docs/media/<demo>.png     the last frame, used as the social preview

Replay is what keeps the GIF honest: no frame is drawn by hand, and the pixels
are the component's own output.

    python3 docs/media/render_media.py            # every capture in build/
    python3 docs/media/render_media.py lite       # one of them

Requirements: Python 3, Pillow, and a monospace font. ffmpeg is optional (the
MP4 is skipped with a note when it is missing).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"

# --- terminal geometry and look ------------------------------------------------

FONT_CANDIDATES = [
    "/home/dahch/.local/share/fonts/JetBrainsMonoNLNerdFontMono-Regular.ttf",
    "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    "/usr/share/fonts/source-foundry-hack-fonts/Hack-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
]
FONT_SIZE = 13
BG = (11, 14, 20)
PAD = 16
BORDER = (35, 40, 51)
# The palette a dark terminal shows for ANSI 0–15; `auto`/`light` themes only use
# a subset of these, and `dark` uses exactly them.
ANSI16 = [
    (14, 17, 23), (205, 49, 49), (13, 188, 121), (229, 229, 16),
    (36, 114, 200), (188, 63, 188), (17, 168, 205), (229, 229, 229),
    (102, 102, 102), (241, 76, 76), (35, 209, 139), (245, 245, 67),
    (59, 142, 234), (214, 112, 214), (41, 184, 219), (255, 255, 255),
]


def xterm256(index: int) -> tuple[int, int, int]:
    if index < 16:
        return ANSI16[index]
    if index < 232:
        steps = [0, 95, 135, 175, 215, 255]
        n = index - 16
        return steps[n // 36], steps[(n // 6) % 6], steps[n % 6]
    grey = 8 + (index - 232) * 10
    return grey, grey, grey


@dataclass(frozen=True)
class Style:
    fg: tuple[int, int, int] | None = None
    bg: tuple[int, int, int] | None = None
    bold: bool = False
    dim: bool = False
    underline: bool = False


DEFAULT_STYLE = Style()


class Screen:
    """A character grid with the ANSI subset Ink emits."""

    def __init__(self, columns: int, rows: int) -> None:
        self.columns = columns
        self.rows = rows
        self.clear()

    def clear(self) -> None:
        self.cells = [[(" ", DEFAULT_STYLE) for _ in range(self.columns)] for _ in range(self.rows)]
        self.row = 0
        self.col = 0
        self.style = DEFAULT_STYLE

    # --- output ------------------------------------------------------------
    def feed(self, data: str) -> None:
        i = 0
        length = len(data)
        while i < length:
            ch = data[i]
            if ch == "\u001b":
                i = self._escape(data, i)
                continue
            i += 1
            if ch == "\r":
                self.col = 0
            elif ch == "\n":
                # A terminal translates LF to CR LF (ONLCR); Ink relies on that.
                self.col = 0
                self.row += 1
                if self.row >= self.rows:
                    self._scroll()
            elif ch == "\b":
                self.col = max(0, self.col - 1)
            elif ch == "\t":
                self.col = min(self.columns - 1, (self.col // 8 + 1) * 8)
            elif ch >= " ":
                self._put(ch)

    def _scroll(self) -> None:
        self.cells.pop(0)
        self.cells.append([(" ", DEFAULT_STYLE) for _ in range(self.columns)])
        self.row = self.rows - 1

    def _put(self, ch: str) -> None:
        if self.col >= self.columns:
            return
        self.cells[self.row][self.col] = (ch, self.style)
        self.col += 1

    def _escape(self, data: str, start: int) -> int:
        nxt = data[start + 1 : start + 2]
        if nxt == "[":
            end = start + 2
            while end < len(data) and not ("@" <= data[end] <= "~"):
                end += 1
            if end >= len(data):
                return len(data)
            params = data[start + 2 : end]
            self._csi(params, data[end])
            return end + 1
        if nxt == "]":
            # OSC: skip to BEL or ST.
            end = start + 2
            while end < len(data):
                if data[end] == "\u0007":
                    return end + 1
                if data[end] == "\u001b" and data[end + 1 : end + 2] == "\\":
                    return end + 2
                end += 1
            return len(data)
        return min(len(data), start + 2)

    def _csi(self, params: str, final: str) -> None:
        # Private modes (`?25l`, `?1049h`, …) carry no printable effect here.
        if params.startswith("?"):
            return
        numbers = [int(p) if p.isdigit() else 0 for p in params.replace(":", ";").split(";")] if params else []
        if final == "m":
            self._sgr(numbers or [0])
        elif final == "A":
            self.row = max(0, self.row - (numbers[0] or 1))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + (numbers[0] or 1))
        elif final == "C":
            self.col = min(self.columns - 1, self.col + (numbers[0] or 1))
        elif final == "D":
            self.col = max(0, self.col - (numbers[0] or 1))
        elif final == "G":
            first = numbers[0] if numbers else 1
            self.col = max(0, min(self.columns - 1, (first or 1) - 1))
        elif final == "H" or final == "f":
            first = numbers[0] if numbers else 1
            self.row = max(0, min(self.rows - 1, (first or 1) - 1))
            self.col = max(0, min(self.columns - 1, (numbers[1] if len(numbers) > 1 else 1) - 1))
        elif final == "K":
            mode = numbers[0] if numbers else 0
            if mode == 0:
                for c in range(self.col, self.columns):
                    self.cells[self.row][c] = (" ", DEFAULT_STYLE)
            elif mode == 1:
                for c in range(0, self.col + 1):
                    self.cells[self.row][c] = (" ", DEFAULT_STYLE)
            else:
                self.cells[self.row] = [(" ", DEFAULT_STYLE) for _ in range(self.columns)]
        elif final == "J":
            mode = numbers[0] if numbers else 0
            if mode == 0:
                for c in range(self.col, self.columns):
                    self.cells[self.row][c] = (" ", DEFAULT_STYLE)
                for r in range(self.row + 1, self.rows):
                    self.cells[r] = [(" ", DEFAULT_STYLE) for _ in range(self.columns)]
            else:
                self.clear()

    def _sgr(self, codes: list[int]) -> None:
        fg, bg, bold, dim, underline = self.style.fg, self.style.bg, self.style.bold, self.style.dim, self.style.underline
        index = 0
        while index < len(codes):
            code = codes[index]
            if code == 0:
                fg, bg, bold, dim, underline = None, None, False, False, False
            elif code == 1:
                bold = True
            elif code == 2:
                dim = True
            elif code == 4:
                underline = True
            elif code in (21, 22):
                bold, dim = False, False
            elif code == 24:
                underline = False
            elif 30 <= code <= 37:
                fg = ANSI16[code - 30]
            elif code == 39:
                fg = None
            elif 40 <= code <= 47:
                bg = ANSI16[code - 40]
            elif code == 49:
                bg = None
            elif 90 <= code <= 97:
                fg = ANSI16[code - 90 + 8]
            elif 100 <= code <= 107:
                bg = ANSI16[code - 100 + 8]
            elif code == 38 or code == 48:
                target = "fg" if code == 38 else "bg"
                if index + 2 < len(codes) and codes[index + 1] == 5:
                    value = xterm256(codes[index + 2])
                    index += 2
                elif index + 4 < len(codes) and codes[index + 1] == 2:
                    value = (codes[index + 2], codes[index + 3], codes[index + 4])
                    index += 4
                else:
                    value = None
                if target == "fg":
                    fg = value
                else:
                    bg = value
            index += 1
        self.style = Style(fg=fg, bg=bg, bold=bold, dim=dim, underline=underline)


# --- rendering ----------------------------------------------------------------


def pick_font() -> str:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    raise SystemExit(
        "no monospace font found; install one (e.g. JetBrains Mono or DejaVu Sans Mono) "
        "or add its path to FONT_CANDIDATES"
    )


def blend(color: tuple[int, int, int], background: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    return tuple(round(color[i] * factor + background[i] * (1 - factor)) for i in range(3))  # type: ignore[return-value]


def frame_image(screen: Screen, font, cell_w: float, cell_h: int) -> Image.Image:
    width = PAD * 2 + round(cell_w * screen.columns)
    height = PAD * 2 + cell_h * screen.rows
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, width - 1, height - 1], outline=BORDER)

    ascent, descent = font.getmetrics()
    baseline_off = (cell_h - (ascent + descent)) // 2 + ascent

    for r, row in enumerate(screen.cells):
        y = PAD + r * cell_h
        c = 0
        while c < screen.columns:
            text, style = row[c]
            start = c
            c += 1
            # One draw call per run of identical style: a frame touches a few
            # hundred runs, not a few thousand cells.
            while c < screen.columns and row[c][1] == style:
                text += row[c][0]
                c += 1
            if not text.strip() and style.bg is None:
                continue
            x = PAD + round(start * cell_w)
            if style.bg is not None:
                draw.rectangle(
                    [x, y, PAD + round(c * cell_w) - 1, y + cell_h - 1], fill=style.bg
                )
            color = style.fg if style.fg is not None else ANSI16[7]
            if style.dim:
                color = blend(color, style.bg or BG, 0.55)
            draw.text((x, y + baseline_off - ascent + 2), text, font=font, fill=color)
            if style.underline:
                draw.line([x, y + baseline_off + 2, x + round(len(text) * cell_w), y + baseline_off + 2], fill=color)
    return image


def load_chunks(path: Path) -> list[dict]:
    chunks = []
    for line in path.read_text().splitlines():
        if line.strip():
            chunks.append(json.loads(line))
    return chunks


def render_demo(name: str, font_path: str) -> None:
    source = BUILD / f"{name}.jsonl"
    chunks = load_chunks(source)
    if not chunks:
        raise SystemExit(f"{source} has no chunks")

    meta = json.loads((BUILD / f"{name}.json").read_text()) if (BUILD / f"{name}.json").exists() else {}
    columns = int(meta.get("columns", 104))
    rows = int(meta.get("rows", 34))
    fps = int(meta.get("fps", 12))
    total = chunks[-1]["t"]

    font = ImageFont.truetype(font_path, FONT_SIZE)
    cell_w = font.getlength("M")
    cell_h = round(FONT_SIZE * 1.42)

    screen = Screen(columns, rows)
    frames: list[Image.Image] = []
    durations: list[int] = []
    # The dashboard's last painted frame: it is the picture worth sharing, even
    # though the recording ends on the receipt.
    dashboard_frame: Image.Image | None = None
    cursor = 0
    frame_ms = 1000 / fps
    t = 0.0

    while t <= total + 1:
        while cursor < len(chunks) and chunks[cursor]["t"] <= t:
            if "\u001b[2J" in chunks[cursor]["data"] and frames:
                dashboard_frame = frames[-1]
            screen.feed(chunks[cursor]["data"])
            cursor += 1
        current = frame_image(screen, font, cell_w, cell_h)
        if frames and current.tobytes() == frames[-1].tobytes():
            durations[-1] += round(frame_ms)
        else:
            frames.append(current)
            durations.append(round(frame_ms))
        t += frame_ms

    # Hold the last frame long enough to be read.
    durations[-1] += 1800
    if len(durations) > 1:
        durations[-1] += 400

    # One palette for the whole animation: adaptive per frame makes text shimmer.
    palette_source = frames[-1].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    quantized = [
        frame.quantize(palette=palette_source, dither=Image.Dither.NONE) for frame in frames
    ]

    gif_path = HERE / f"{name}.gif"
    quantized[0].save(
        gif_path,
        save_all=True,
        append_images=quantized[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    (dashboard_frame or frames[-1]).save(HERE / f"{name}.png", optimize=True)

    mp4_path = HERE / f"{name}.mp4"
    if shutil.which("ffmpeg"):
        # Rebuild the timeline as a CFR sequence so the MP4 plays everywhere.
        still = BUILD / f"{name}-frames"
        still.mkdir(parents=True, exist_ok=True)
        sequence_index = 0
        for frame, duration in zip(frames, durations):
            for _ in range(max(1, round(duration / frame_ms))):
                frame.save(still / f"{sequence_index:05d}.png")
                sequence_index += 1
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-framerate", str(fps),
                "-i", str(still / "%05d.png"),
                "-pix_fmt", "yuv420p",
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                str(mp4_path),
            ],
            check=True,
        )
        shutil.rmtree(still, ignore_errors=True)
    else:
        print("  (ffmpeg not found: skipping the MP4)")

    gif_kb = gif_path.stat().st_size // 1024
    print(f"  {gif_path.name}: {len(frames)} unique frames, {total / 1000:.1f}s, {gif_kb} KB")
    if mp4_path.exists():
        print(f"  {mp4_path.name}: {mp4_path.stat().st_size // 1024} KB")
    print(f"  {name}.png: dashboard frame ({PAD * 2 + round(cell_w * columns)}x{PAD * 2 + cell_h * rows})")


def main() -> None:
    names = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    if not names:
        names = sorted(path.stem for path in BUILD.glob("*.jsonl"))
    if not names:
        raise SystemExit("nothing to render: run `bun docs/media/capture.ts` first")
    font_path = pick_font()
    print(f"font: {font_path}")
    for name in names:
        print(f"[{name}]")
        render_demo(name, font_path)


if __name__ == "__main__":
    main()
