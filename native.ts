/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs in Discord's main process. Nothing happens at import time: the renderer
// side (index.ts) calls start() when the plugin is enabled and stop() when it
// is disabled.
//
// HTTP API on 127.0.0.1:<port> (default 37321) for the Stream Deck plugin:
//   GET  /health                    { ok, name, version, renderer }
//   GET  /events?client=<id>        Server-Sent Events: "hello", "view", "status"
//   POST /views    { client, views } which users/looks this client shows
//   POST /adjust   { userId, context, delta, detent? }
//   POST /set      { userId, context, volume }
//   POST /mute     { userId, context, mode: "toggle" | "on" | "off" }
//   GET  /suggestions               people to offer in the settings panel
//   GET  /user?id=<snowflake>       resolve one user
//
// Every call except /health and /events is forwarded to the renderer
// (window.__UserVolumeDeck.call), which owns all Discord state.
//
// Browsers can't use this API: requests with an Origin header are refused
// (browsers always send one cross-origin), POST bodies must be JSON (forces a
// CORS preflight, which gets no CORS headers) and the Host header must be
// 127.0.0.1 / localhost (stops DNS rebinding).

import type { IpcMainInvokeEvent, WebContents } from "electron";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";

const NAME = "UserVolumeDeck";
const VERSION = "1.0.0";
const MAX_BODY = 64 * 1024;
const CLIENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_IMAGE = 4 * 1024 * 1024;

let server: Server | null = null;
let serverPort = 0;
let renderer: WebContents | null = null;
const streams = new Map<string, ServerResponse>();
let keepAlive: NodeJS.Timeout | null = null;

const log = (...a: unknown[]) => console.log("[UserVolumeDeck Native]", ...a);

function rendererAlive(): boolean {
    return !!renderer && !renderer.isDestroyed();
}

async function callRenderer(method: string, args: unknown): Promise<unknown> {
    if (!rendererAlive()) throw Object.assign(new Error("Discord is not ready"), { status: 503 });
    const code = `(window.__UserVolumeDeck ? window.__UserVolumeDeck.call(${JSON.stringify(method)}, ${JSON.stringify(args ?? {})}) : Promise.reject(new Error("UserVolumeDeck is not running")))`;
    return renderer!.executeJavaScript(code);
}

function send(res: ServerResponse, status: number, data: unknown) {
    if (res.headersSent) return;
    const body = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store"
    });
    res.end(body);
}

function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error("Body too large"), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
            }
        });
        req.on("error", reject);
    });
}

function writeEvent(res: ServerResponse, event: string, data: string) {
    try {
        res.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch { /* closed */ }
}

function openStream(req: IncomingMessage, res: ServerResponse, client: string) {
    // One stream per client id: a reconnect replaces the old one.
    streams.get(client)?.end();
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });
    res.write(": hi\n\n");
    streams.set(client, res);
    req.socket.setKeepAlive(true);
    req.socket.setNoDelay(true);

    const done = () => {
        if (streams.get(client) !== res) return;
        streams.delete(client);
        callRenderer("dropClient", { client }).catch(() => { });
    };
    req.on("close", done);
    res.on("error", done);

    callRenderer("hello", { client })
        .then(info => writeEvent(res, "hello", JSON.stringify(info)))
        .catch(e => writeEvent(res, "status", JSON.stringify({ renderer: false, error: String(e?.message ?? e) })));
}

const ROUTES: Record<string, { method: "GET" | "POST"; call: string; }> = {
    "/views": { method: "POST", call: "setViews" },
    "/adjust": { method: "POST", call: "adjust" },
    "/set": { method: "POST", call: "set" },
    "/mute": { method: "POST", call: "mute" },
    "/suggestions": { method: "GET", call: "suggestions" },
    "/user": { method: "GET", call: "user" },
    "/status": { method: "GET", call: "status" }
};

async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${serverPort}` && host !== `localhost:${serverPort}`) return send(res, 403, { error: "Bad host" });
    if (req.headers.origin) return send(res, 403, { error: "Browsers are not allowed" });

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") {
        return send(res, 200, { ok: true, name: NAME, version: VERSION, renderer: rendererAlive() });
    }

    if (path === "/events" && req.method === "GET") {
        const client = url.searchParams.get("client") ?? "";
        if (!CLIENT_RE.test(client)) return send(res, 400, { error: "Bad client id" });
        return openStream(req, res, client);
    }

    const route = ROUTES[path];
    if (!route) return send(res, 404, { error: "Not found" });
    if (req.method !== route.method) return send(res, 405, { error: "Method not allowed" });

    let args: any;
    if (route.method === "POST") {
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "JSON only" });
        args = await readBody(req);
        if (!args || typeof args !== "object" || Array.isArray(args)) return send(res, 400, { error: "Body must be an object" });
    } else {
        args = Object.fromEntries(url.searchParams);
    }

    const result = await callRenderer(route.call, args);
    send(res, 200, result ?? { ok: true });
}

function closeServer() {
    for (const res of streams.values()) {
        try { res.end(); } catch { /* ignore */ }
    }
    streams.clear();
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = null;
    if (server) {
        server.close();
        server = null;
        log("HTTP server stopped");
    }
    serverPort = 0;
}

/** Called by the renderer when the plugin starts (and again after a reload). */
export function start(event: IpcMainInvokeEvent, port: number): Promise<{ ok: boolean; port: number; error?: string; }> {
    renderer = event.sender;
    const p = Number.isInteger(port) && port > 1024 && port < 65536 ? port : 37321;
    if (server && serverPort === p) {
        // Discord reloaded: the renderer forgot every client's views, so ask
        // the Stream Deck plugins to send them again.
        for (const res of streams.values()) writeEvent(res, "reset", "{}");
        return Promise.resolve({ ok: true, port: p });
    }
    closeServer();

    return new Promise(resolve => {
        const srv = createServer((req, res) => {
            handle(req, res).catch(e => send(res, e?.status ?? 500, { error: String(e?.message ?? e) }));
        });
        srv.keepAliveTimeout = 30_000;
        srv.on("error", (e: NodeJS.ErrnoException) => {
            log("HTTP server error:", e);
            if (server === srv) server = null;
            resolve({ ok: false, port: p, error: e.code === "EADDRINUSE" ? `Port ${p} is already in use` : String(e.message) });
        });
        srv.listen(p, "127.0.0.1", () => {
            server = srv;
            serverPort = p;
            keepAlive = setInterval(() => {
                for (const res of streams.values()) {
                    try { res.write(": ping\n\n"); } catch { /* closed */ }
                }
            }, 15_000);
            log(`HTTP API on http://127.0.0.1:${p}`);
            resolve({ ok: true, port: p });
        });
    });
}

export function stop(_: IpcMainInvokeEvent) {
    closeServer();
    renderer = null;
}

/** Renderer → Stream Deck: one event to one client ("*" = every client). */
export function push(_: IpcMainInvokeEvent, client: string, event: string, data: string) {
    if (client === "*") {
        for (const res of streams.values()) writeEvent(res, event, data);
        return;
    }
    const res = streams.get(client);
    if (res) writeEvent(res, event, data);
}

/**
 * Avatar bytes as a data: URL. Fetched here (no CORS in the main process) so
 * the renderer can draw them on a canvas without tainting it.
 */
export async function fetchImage(_: IpcMainInvokeEvent, url: string): Promise<string | null> {
    try {
        const u = new URL(url);
        if (u.protocol !== "https:" || !IMAGE_HOSTS.has(u.hostname)) return null;
        const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;
        const type = (r.headers.get("content-type") ?? "image/png").split(";")[0].trim();
        if (!type.startsWith("image/")) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MAX_IMAGE) return null;
        return `data:${type};base64,${buf.toString("base64")}`;
    } catch {
        return null;
    }
}
