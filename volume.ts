/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Discord stores a user's local volume as an AMPLITUDE (100 = unchanged) but
// its "User Volume" slider shows a PERCEPTUAL value, converted with
// @discordapp/perceptual (50 dB range below 100 %, 6 dB of boost above it).
// So slider 200 % ≈ amplitude 199.5 and VolumeBooster's 400 % ≈ amplitude 794.
//
// Everything this plugin shows and accepts is on the scale chosen in the
// settings: "discord" = the same number Discord's slider shows (default),
// "linear" = the raw stored amplitude.

const NORM = 100;
const RANGE_DB = 50;
const BOOST_DB = 6;

export function perceptualToAmplitude(p: number): number {
    if (p <= 0) return 0;
    const db = p > NORM ? (p - NORM) / NORM * BOOST_DB : p / NORM * RANGE_DB - RANGE_DB;
    return NORM * Math.pow(10, db / 20);
}

export function amplitudeToPerceptual(a: number): number {
    if (a <= 0) return 0;
    const db = 20 * Math.log10(a / NORM);
    const p = db > 0 ? (db / BOOST_DB + 1) * NORM : (RANGE_DB + db) / RANGE_DB * NORM;
    return Math.max(0, p);
}

export type Scale = "discord" | "linear";

export const toDisplay = (amplitude: number, scale: Scale) =>
    scale === "linear" ? amplitude : amplitudeToPerceptual(amplitude);

export const fromDisplay = (value: number, scale: Scale) =>
    scale === "linear" ? value : perceptualToAmplitude(value);
