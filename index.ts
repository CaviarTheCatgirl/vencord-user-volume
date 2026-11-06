/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings, Settings, SettingsStore } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import {
    ChannelStore,
    FluxDispatcher,
    MediaEngineStore,
    RelationshipStore,
    SelectedChannelStore,
    UserAffinitiesStore,
    UserStore,
    UserUtils,
    VoiceStateStore
} from "@webpack/common";

import { type LookOptions, renderKey, renderStrip, type ViewState } from "./render";
import { fromDisplay, type Scale, toDisplay } from "./volume";

const Native = VencordNative.pluginHelpers.UserVolumeDeck as PluginNative<typeof import("./native")>;
const SpeakingStore = findStoreLazy("SpeakingStore") as { isSpeaking?(userId: string, context?: string): boolean; addChangeListener(cb: () => void): void; removeChangeListener(cb: () => void): void; };

const VERSION = "1.0.0";
const TAG = "[UserVolumeDeck]";
const ID_RE = /^\d{15,22}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_VIEWS = 128;

type Ctx = "default" | "stream";
const CONTEXTS: Ctx[] = ["default", "stream"];

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Local port the Stream Deck plugin connects to (must match the port in the Stream Deck plugin's settings)",
        default: 37321,
        restartNeeded: true
    },
    scale: {
        type: OptionType.SELECT,
        description: "Volume numbers on the Stream Deck",
        options: [
            { label: "Same as Discord's user volume slider", value: "discord", default: true },
            { label: "Raw stored value (linear)", value: "linear" }
        ],
        onChange: () => scheduleRefresh(true)
    },
    maxVolume: {
        type: OptionType.NUMBER,
        description: "Highest volume the Stream Deck may set, in %. 0 = automatic (200 %, times VolumeBooster's multiplier when that plugin is on)",
        default: 0,
        onChange: () => scheduleRefresh(true)
    }
});

// ── volume model ────────────────────────────────────────────────────────────

const scale = (): Scale => (settings.store.scale === "linear" ? "linear" : "discord");

function maxVolume(): number {
    const override = Number(settings.store.maxVolume);
    if (Number.isFinite(override) && override > 0) return Math.min(override, 5000);
    // Same base as Discord's slider: 200 on the desktop app, 100 elsewhere.
    const base = (window as any).DiscordNative ? 200 : 100;
    if (!isPluginEnabled("VolumeBooster")) return base;
    const mult = Number((Settings.plugins.VolumeBooster as any)?.multiplier ?? 2);
    return base * (Number.isFinite(mult) && mult > 0 ? mult : 1);
}

function readVolume(userId: string, context: Ctx): number {
    return toDisplay(MediaEngineStore.getLocalVolume(userId, context) ?? 100, scale());
}

function writeVolume(userId: string, context: Ctx, display: number) {
    // The same action Discord's own user-volume slider dispatches.
    FluxDispatcher.dispatch({ type: "AUDIO_SET_LOCAL_VOLUME", context, userId, volume: fromDisplay(display, scale()) });
}

function isMuted(userId: string, context: Ctx): boolean {
    return !!MediaEngineStore.isLocalMute(userId, context);
}

function toggleMute(userId: string, context: Ctx) {
    FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_LOCAL_MUTE", context, userId });
}

// ── users ───────────────────────────────────────────────────────────────────

const fetching = new Set<string>();
const unknownUsers = new Map<string, number>();

function lookupUser(id: string): any | null {
    const u = UserStore.getUser(id);
    if (u) return u;
    const failedAt = unknownUsers.get(id);
    if (!fetching.has(id) && (!failedAt || Date.now() - failedAt > 5 * 60_000)) {
        fetching.add(id);
        Promise.resolve(UserUtils.getUser(id))
            .then(() => unknownUsers.delete(id))
            .catch(() => unknownUsers.set(id, Date.now()))
            .finally(() => {
                fetching.delete(id);
                scheduleRefresh();
            });
    }
    return null;
}

function nameOf(user: any, id: string): string {
    if (!user) return unknownUsers.has(id) ? "Unknown user" : "Loading…";
    return RelationshipStore.getNickname(id) || user.globalName || user.username || id;
}

function avatarUrl(user: any, size: number): string | null {
    try {
        return user?.getAvatarURL?.(undefined, size, false) ?? null;
    } catch {
        return null;
    }
}

function userInfo(id: string, user = lookupUser(id)) {
    return {
        id,
        known: !!user,
        name: nameOf(user, id),
        username: user?.username ?? "",
        avatar: avatarUrl(user, 64)
    };
}

// ── avatars (as decoded images for the canvas) ──────────────────────────────

interface AvatarEntry { state: "loading" | "ok" | "failed"; img?: HTMLImageElement; at: number; }
const avatars = new Map<string, AvatarEntry>();

function avatarImage(url: string | null): { img: HTMLImageElement | null; key: string; } {
    if (!url) return { img: null, key: "none" };
    const e = avatars.get(url);
    if (e?.state === "ok") return { img: e.img!, key: url };
    if (e?.state === "loading") return { img: null, key: `${url}#loading` };
    if (e?.state === "failed" && Date.now() - e.at < 60_000) return { img: null, key: `${url}#failed` };

    const entry: AvatarEntry = { state: "loading", at: Date.now() };
    avatars.set(url, entry);
    if (avatars.size > 200) avatars.delete(avatars.keys().next().value!);
    Native.fetchImage(url)
        .then(async data => {
            if (!data) throw new Error("no image");
            const img = new Image();
            img.src = data;
            await img.decode();
            entry.img = img;
            entry.state = "ok";
        })
        .catch(() => {
            entry.state = "failed";
            entry.at = Date.now();
        })
        .finally(() => scheduleRefresh());
    return { img: null, key: `${url}#loading` };
}

// ── views: what each Stream Deck client shows ───────────────────────────────

interface ViewSpec { id: string; userId: string; context: Ctx; kind: "key" | "strip"; look: LookOptions; }
interface LiveView { spec: ViewSpec; sig: string; }
const clients = new Map<string, Map<string, LiveView>>();

function myVoiceChannel(): string | null {
    return SelectedChannelStore.getVoiceChannelId() ?? null;
}

function stateOf(userId: string, context: Ctx): ViewState {
    const user = lookupUser(userId);
    const vc = myVoiceChannel();
    let speaking = false;
    try {
        speaking = !!SpeakingStore.isSpeaking?.(userId, context === "stream" ? "stream" : "default");
    } catch { /* store missing */ }
    return {
        userId,
        known: !!user,
        name: nameOf(user, userId),
        username: user?.username ?? "",
        volume: readVolume(userId, context),
        max: maxVolume(),
        muted: isMuted(userId, context),
        speaking,
        inCall: !!vc && !!VoiceStateStore.getVoiceStateForChannel(vc, userId)
    };
}

let scheduled = false;
let forceNext = false;

function scheduleRefresh(force = false) {
    if (force) forceNext = true;
    if (scheduled) return;
    scheduled = true;
    // A microtask, not a timer: timers are throttled while Discord is hidden.
    queueMicrotask(refresh);
}

function refresh() {
    scheduled = false;
    const force = forceNext;
    forceNext = false;
    if (!clients.size) return;

    // States are shared by every view of the same user + context.
    const states = new Map<string, ViewState>();
    for (const [client, views] of clients) {
        for (const view of views.values()) {
            const { spec } = view;
            const k = `${spec.userId}:${spec.context}`;
            let s = states.get(k);
            if (!s) states.set(k, s = stateOf(spec.userId, spec.context));
            const av = avatarImage(avatarUrl(UserStore.getUser(spec.userId), 128));
            const sig = JSON.stringify([
                spec.kind, spec.look.showName ?? false, av.key,
                s.name, Math.round(s.volume * 10), s.max, s.muted, s.speaking, s.inCall, s.known
            ]);
            if (!force && sig === view.sig) continue;
            view.sig = sig;
            let image: string | null = null;
            try {
                image = spec.kind === "strip" ? renderStrip(s, av.img) : renderKey(s, av.img, spec.look);
            } catch (e) {
                console.error(TAG, "render failed", e);
            }
            const payload = JSON.stringify({ id: spec.id, state: { ...s, volume: Math.round(s.volume * 10) / 10 }, image });
            Native.push(client, "view", payload).catch(() => { });
        }
    }
}

const onStoreChange = () => scheduleRefresh();

// ── API called by native.ts (window.__UserVolumeDeck.call) ──────────────────

class ApiError extends Error { }

function needUser(v: unknown): string {
    const id = String(v ?? "");
    if (!ID_RE.test(id)) throw new ApiError("Invalid user id");
    return id;
}
function needContext(v: unknown): Ctx {
    return CONTEXTS.includes(v as Ctx) ? v as Ctx : "default";
}
function needNumber(v: unknown, lo: number, hi: number): number {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ApiError("Not a number");
    return Math.min(hi, Math.max(lo, n));
}

function result(userId: string, context: Ctx, extra: Record<string, unknown> = {}) {
    return { userId, context, volume: Math.round(readVolume(userId, context) * 10) / 10, max: maxVolume(), muted: isMuted(userId, context), ...extra };
}

const api: Record<string, (args: any) => unknown> = {
    hello({ client }) {
        if (CLIENT_RE.test(String(client))) scheduleRefresh(true);
        return api.status({});
    },

    status() {
        return { name: "UserVolumeDeck", version: VERSION, max: maxVolume(), scale: scale(), me: UserStore.getCurrentUser()?.id ?? null, voiceChannel: myVoiceChannel() };
    },

    dropClient({ client }) {
        clients.delete(String(client));
        return { ok: true };
    },

    setViews({ client, views }) {
        const cid = String(client ?? "");
        if (!CLIENT_RE.test(cid)) throw new ApiError("Bad client id");
        if (!Array.isArray(views)) throw new ApiError("views must be an array");
        const old = clients.get(cid) ?? new Map<string, LiveView>();
        const next = new Map<string, LiveView>();
        for (const raw of views.slice(0, MAX_VIEWS)) {
            if (!raw || typeof raw !== "object") continue;
            const id = String(raw.id ?? "");
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !ID_RE.test(String(raw.userId ?? ""))) continue;
            const spec: ViewSpec = {
                id,
                userId: String(raw.userId),
                context: needContext(raw.context),
                kind: raw.kind === "strip" ? "strip" : "key",
                look: { showName: !!raw.look?.showName }
            };
            const prev = old.get(id);
            // Unchanged views keep their signature so they aren't re-sent.
            const same = prev && JSON.stringify(prev.spec) === JSON.stringify(spec);
            next.set(id, { spec, sig: same ? prev.sig : "" });
        }
        clients.set(cid, next);
        scheduleRefresh();
        return { ok: true, views: next.size };
    },

    adjust({ userId, context, delta, detent }) {
        const id = needUser(userId);
        const ctx = needContext(context);
        const d = needNumber(delta, -1000, 1000);
        const max = maxVolume();
        const cur = readVolume(id, ctx);
        // Never pull a volume that is already above the limit down by turning UP.
        let next = d >= 0 ? Math.min(cur + d, Math.max(cur, max)) : Math.max(0, cur + d);
        let hitDetent = false;
        const at = Number(detent);
        if (Number.isFinite(at) && at > 0) {
            const crossesUp = cur < at - 0.05 && next > at + 0.05;
            const crossesDown = cur > at + 0.05 && next < at - 0.05;
            if (crossesUp || crossesDown) {
                next = at;
                hitDetent = true;
            }
        }
        if (Math.abs(next - cur) > 1e-6) writeVolume(id, ctx, next);
        return result(id, ctx, { hitDetent, atLimit: d > 0 ? next >= max : next <= 0 });
    },

    set({ userId, context, volume }) {
        const id = needUser(userId);
        const ctx = needContext(context);
        writeVolume(id, ctx, needNumber(volume, 0, maxVolume()));
        return result(id, ctx);
    },

    mute({ userId, context, mode }) {
        const id = needUser(userId);
        const ctx = needContext(context);
        const muted = isMuted(id, ctx);
        const want = mode === "on" ? true : mode === "off" ? false : !muted;
        if (want !== muted) toggleMute(id, ctx);
        return result(id, ctx);
    },

    async user({ id }) {
        const uid = needUser(id);
        let user = UserStore.getUser(uid);
        if (!user) {
            try {
                user = await UserUtils.getUser(uid);
            } catch {
                user = null as any;
            }
        }
        if (!user) return { id: uid, known: false, name: "Unknown user", username: "", avatar: null };
        return { ...userInfo(uid, user), volume: Math.round(readVolume(uid, "default")), muted: isMuted(uid, "default") };
    },

    suggestions() {
        const me = UserStore.getCurrentUser()?.id;
        const order: string[] = [];
        const tags = new Map<string, Set<string>>();
        const add = (id: string | undefined | null, tag: string) => {
            if (!id || id === me || !ID_RE.test(id)) return;
            if (!tags.has(id)) {
                tags.set(id, new Set());
                order.push(id);
            }
            tags.get(id)!.add(tag);
        };

        // 1. In your voice call right now
        const vc = myVoiceChannel();
        if (vc) for (const id of Object.keys(VoiceStateStore.getVoiceStatesForChannel(vc) ?? {})) add(id, "call");

        // 2. People whose volume you already changed
        try {
            const s: any = MediaEngineStore.getSettings("default");
            for (const [id, v] of Object.entries(s?.localVolumes ?? {})) if (Math.abs(Number(v) - 100) > 0.5) add(id, "adjusted");
            for (const [id, m] of Object.entries(s?.localMutes ?? {})) if (m) add(id, "adjusted");
        } catch { /* ignore */ }

        // 3. People Discord thinks you talk to most
        try {
            const aff = [...(UserAffinitiesStore.getUserAffinities() ?? [])]
                .sort((a: any, b: any) => (Math.max(b.communicationProbability ?? 0, b.vcProbability ?? 0)) - (Math.max(a.communicationProbability ?? 0, a.vcProbability ?? 0)));
            for (const a of aff.slice(0, 15)) add(a.otherUserId, "frequent");
        } catch { /* store changed */ }

        // 4. Recent DMs
        try {
            const dms = (ChannelStore.getSortedPrivateChannels() ?? []).filter((c: any) => c?.type === 1).slice(0, 15);
            for (const c of dms) add((c as any).recipients?.[0], "dm");
        } catch { /* ignore */ }

        // 5. Friends (searchable in the settings panel)
        try {
            for (const id of (RelationshipStore.getFriendIDs() ?? []).slice(0, 500)) add(id, "friend");
        } catch { /* ignore */ }

        const users = order.map(id => {
            const user = UserStore.getUser(id);
            return {
                ...userInfo(id, user ?? null),
                tags: [...tags.get(id)!],
                volume: Math.round(readVolume(id, "default")),
                muted: isMuted(id, "default")
            };
        }).filter(u => u.known || u.tags.some(t => t !== "friend"));

        return { me, max: maxVolume(), scale: scale(), users };
    }
};

async function call(method: string, args: unknown) {
    const fn = Object.prototype.hasOwnProperty.call(api, method) ? api[method] : null;
    if (!fn) throw new Error(`Unknown method ${method}`);
    try {
        return await fn(args ?? {});
    } catch (e) {
        if (e instanceof ApiError) return { error: e.message };
        throw e;
    }
}

// ── plugin ──────────────────────────────────────────────────────────────────

const onVolumeBoosterChange = () => scheduleRefresh(true);

export default definePlugin({
    name: "UserVolumeDeck",
    description: "Control one person's Discord volume from a Stream Deck key or dial (with avatar and live volume). Needs the \"Discord User Volume\" Stream Deck plugin.",
    authors: [{ name: "DarkSide1305", id: 108530201708773376n }],
    settings,

    async start() {
        (window as any).__UserVolumeDeck = { call, version: VERSION };

        MediaEngineStore.addChangeListener(onStoreChange);
        VoiceStateStore.addChangeListener(onStoreChange);
        UserStore.addChangeListener(onStoreChange);
        RelationshipStore.addChangeListener(onStoreChange);
        try { SpeakingStore.addChangeListener(onStoreChange); } catch { /* not found */ }
        SettingsStore.addPrefixChangeListener("plugins.VolumeBooster", onVolumeBoosterChange);

        if (!Native?.start) {
            console.warn(TAG, "No native helper: only the Discord desktop app is supported");
            return;
        }
        const r = await Native.start(Number(settings.store.port) || 37321);
        if (r.ok) {
            console.log(TAG, `Stream Deck bridge on 127.0.0.1:${r.port}`);
        } else {
            console.error(TAG, r.error);
            showNotification({ title: "UserVolumeDeck", body: `Stream Deck bridge did not start: ${r.error}` });
        }
    },

    stop() {
        MediaEngineStore.removeChangeListener(onStoreChange);
        VoiceStateStore.removeChangeListener(onStoreChange);
        UserStore.removeChangeListener(onStoreChange);
        RelationshipStore.removeChangeListener(onStoreChange);
        try { SpeakingStore.removeChangeListener(onStoreChange); } catch { /* not found */ }
        SettingsStore.removePrefixChangeListener("plugins.VolumeBooster", onVolumeBoosterChange);

        clients.clear();
        avatars.clear();
        delete (window as any).__UserVolumeDeck;
        Native?.stop?.().catch(() => { });
    }
});
