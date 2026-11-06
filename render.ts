/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Draws the Stream Deck images on a canvas in Discord's renderer (Chromium),
// so the Stream Deck side never has to rasterize anything:
//   key    144 × 144  avatar with a volume ring, volume underneath
//   strip  200 × 100  one Stream Deck + touch-strip segment: avatar, name,
//                     volume and a bar with a 100 % mark
// Avatars arrive as data: URLs (native.ts fetchImage), so the canvas is never
// tainted and toDataURL() works.

export interface ViewState {
    userId: string;
    known: boolean;
    name: string;
    username: string;
    /** on the configured scale, unrounded */
    volume: number;
    max: number;
    muted: boolean;
    speaking: boolean;
    inCall: boolean;
}

export interface LookOptions {
    showName?: boolean;
}

const FONT = "\"gg sans\", \"Noto Sans\", \"Helvetica Neue\", Helvetica, Arial, sans-serif";
const C = {
    bg: "#0e0f12",
    track: "#2b2d33",
    text: "#f2f3f5",
    sub: "#b5bac1",
    dim: "#80848e",
    green: "#3ba55d",
    amber: "#faa61a",
    red: "#ed4245",
    blurple: "#5865f2",
    tick: "#ffffff"
};

let canvas: HTMLCanvasElement | null = null;
function ctx2d(w: number, h: number): CanvasRenderingContext2D {
    canvas ??= document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d")!;
    c.reset?.();
    c.clearRect(0, 0, w, h);
    return c;
}

export const pct = (v: number) => `${Math.round(v)}%`;

/** Colour for a volume: normal up to 100 %, boosted up to 200 %, beyond that red. */
function volumeColor(v: number, muted: boolean): string {
    if (muted) return C.dim;
    if (v <= 100.5) return C.green;
    if (v <= 200.5) return C.amber;
    return C.red;
}

function fitText(c: CanvasRenderingContext2D, text: string, weight: number, size: number, maxWidth: number, minSize = 10): string {
    let s = size;
    for (; s > minSize; s--) {
        c.font = `${weight} ${s}px ${FONT}`;
        if (c.measureText(text).width <= maxWidth) return text;
    }
    c.font = `${weight} ${minSize}px ${FONT}`;
    let t = text;
    while (t.length > 1 && c.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
    return t === text ? t : t + "…";
}

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const s = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? "?").slice(0, 2);
    return s.toUpperCase();
}

function drawAvatar(c: CanvasRenderingContext2D, img: CanvasImageSource | null, s: ViewState, cx: number, cy: number, r: number) {
    c.save();
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.closePath();
    c.clip();
    if (img) {
        if (s.muted) c.filter = "grayscale(1) brightness(0.55)";
        c.drawImage(img, cx - r, cy - r, r * 2, r * 2);
        c.filter = "none";
    } else {
        c.fillStyle = s.muted ? "#3a3c42" : C.blurple;
        c.fillRect(cx - r, cy - r, r * 2, r * 2);
        c.fillStyle = C.text;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.font = `700 ${Math.round(r * 0.8)}px ${FONT}`;
        c.fillText(s.known ? initials(s.name) : "?", cx, cy + 1);
    }
    c.restore();

    if (s.speaking && !s.muted) {
        c.beginPath();
        c.arc(cx, cy, r + 1.5, 0, Math.PI * 2);
        c.strokeStyle = C.green;
        c.lineWidth = 3;
        c.stroke();
    }
}

/** Small red "speaker with a slash" badge. */
function drawMutedBadge(c: CanvasRenderingContext2D, x: number, y: number, size: number) {
    const r = size / 2;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = C.red;
    c.fill();
    c.lineWidth = Math.max(2, size * 0.08);
    c.strokeStyle = C.bg;
    c.stroke();

    const u = size / 24;
    c.save();
    c.translate(x - 12 * u, y - 12 * u);
    c.fillStyle = "#fff";
    c.beginPath();
    c.moveTo(5 * u, 9 * u);
    c.lineTo(9 * u, 9 * u);
    c.lineTo(13 * u, 5.5 * u);
    c.lineTo(13 * u, 18.5 * u);
    c.lineTo(9 * u, 15 * u);
    c.lineTo(5 * u, 15 * u);
    c.closePath();
    c.fill();
    c.strokeStyle = "#fff";
    c.lineWidth = 2 * u;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(15.5 * u, 9.5 * u);
    c.lineTo(20 * u, 14.5 * u);
    c.moveTo(20 * u, 9.5 * u);
    c.lineTo(15.5 * u, 14.5 * u);
    c.stroke();
    c.restore();
}

function drawRing(c: CanvasRenderingContext2D, s: ViewState, cx: number, cy: number, r: number, width: number) {
    const start = -Math.PI / 2;
    const frac = s.max > 0 ? Math.min(1, Math.max(0, s.volume / s.max)) : 0;

    c.lineCap = "butt";
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.strokeStyle = C.track;
    c.lineWidth = width;
    c.stroke();

    if (frac > 0.001) {
        c.beginPath();
        c.arc(cx, cy, r, start, start + frac * Math.PI * 2);
        c.strokeStyle = volumeColor(s.volume, s.muted);
        c.lineWidth = width;
        c.lineCap = "round";
        c.stroke();
        c.lineCap = "butt";
    }

    // 100 % mark (only when the scale goes past it)
    if (s.max > 100) {
        const a = start + (100 / s.max) * Math.PI * 2;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * (r - width / 2 - 1), cy + Math.sin(a) * (r - width / 2 - 1));
        c.lineTo(cx + Math.cos(a) * (r + width / 2 + 1), cy + Math.sin(a) * (r + width / 2 + 1));
        c.strokeStyle = C.tick;
        c.lineWidth = 2;
        c.stroke();
    }
}

export function renderKey(s: ViewState, avatar: CanvasImageSource | null, look: LookOptions): string {
    const c = ctx2d(144, 144);
    c.fillStyle = C.bg;
    c.fillRect(0, 0, 144, 144);

    const withName = !!look.showName;
    const cx = 72;
    const cy = withName ? 46 : 58;
    const ringR = withName ? 39 : 50;
    const ringW = withName ? 6 : 7;
    const avR = ringR - ringW / 2 - 4;

    drawRing(c, s, cx, cy, ringR, ringW);
    drawAvatar(c, avatar, s, cx, cy, avR);
    if (s.muted) drawMutedBadge(c, cx + avR * 0.72, cy + avR * 0.72, withName ? 22 : 28);

    c.textAlign = "center";
    c.textBaseline = "alphabetic";

    if (withName) {
        c.fillStyle = C.sub;
        const name = fitText(c, s.name, 600, 16, 132, 11);
        c.fillText(name, cx, 106);
    }

    const label = s.muted ? "Muted" : pct(s.volume);
    c.fillStyle = s.muted ? C.red : C.text;
    const text = fitText(c, label, 800, withName ? 26 : 30, 132, 14);
    c.fillText(text, cx, withName ? 135 : 136);

    return canvas!.toDataURL("image/png");
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}

export function renderStrip(s: ViewState, avatar: CanvasImageSource | null): string {
    const W = 200, H = 100;
    const c = ctx2d(W, H);
    c.fillStyle = C.bg;
    c.fillRect(0, 0, W, H);

    const cx = 40, cy = 50, r = 30;
    drawAvatar(c, avatar, s, cx, cy, r);
    if (s.muted) drawMutedBadge(c, cx + r * 0.75, cy + r * 0.75, 22);

    const x0 = 82, x1 = 192, w = x1 - x0;
    c.textAlign = "left";
    c.textBaseline = "alphabetic";

    c.fillStyle = C.sub;
    c.fillText(fitText(c, s.name, 600, 15, w, 11), x0, 26);

    const color = volumeColor(s.volume, s.muted);
    c.fillStyle = s.muted ? C.dim : C.text;
    c.fillText(fitText(c, pct(s.volume), 800, 30, w, 16), x0, 60);

    // bar
    const by = 72, bh = 9;
    roundRect(c, x0, by, w, bh, bh / 2);
    c.fillStyle = C.track;
    c.fill();
    const frac = s.max > 0 ? Math.min(1, Math.max(0, s.volume / s.max)) : 0;
    if (frac > 0.002) {
        c.save();
        roundRect(c, x0, by, w, bh, bh / 2);
        c.clip();
        c.fillStyle = color;
        c.fillRect(x0, by, w * frac, bh);
        c.restore();
    }
    if (s.max > 100) {
        const tx = Math.round(x0 + w * (100 / s.max)) + 0.5;
        c.beginPath();
        c.moveTo(tx, by - 3);
        c.lineTo(tx, by + bh + 3);
        c.strokeStyle = C.tick;
        c.lineWidth = 2;
        c.stroke();
    }

    c.fillStyle = C.dim;
    c.font = `600 10px ${FONT}`;
    c.textAlign = "left";
    c.fillText("0", x0, 95);
    c.textAlign = "right";
    if (s.muted) {
        c.fillStyle = C.red;
        c.font = `800 10px ${FONT}`;
        c.fillText("MUTED", x1, 95);
        c.fillStyle = C.dim;
        c.font = `600 10px ${FONT}`;
    } else {
        c.fillText(pct(s.max), x1, 95);
    }
    if (s.max > 100) {
        c.textAlign = "center";
        const tx = x0 + w * (100 / s.max);
        if (tx - x0 > 14 && x1 - tx > 26) c.fillText("100", tx, 95);
    }

    return canvas!.toDataURL("image/png");
}
