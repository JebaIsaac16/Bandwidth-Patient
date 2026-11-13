/*
 * server.js — Patient Voice Backend
 *
 * No DB, no verification, no history, no queue.
 * Patients log in, make outbound calls to doctors,
 * and receive inbound calls from doctors.
 */

const express = require("express");
const cors    = require("cors");
const dotenv  = require("dotenv");
const axios   = require("axios");
const path    = require("path");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "../public")));

const PORT = process.env.PORT || 4000;

/* ----------------------------------------
 * ENV
 * ---------------------------------------- */

const ACCOUNT_ID     = process.env.BANDWIDTH_ACCOUNT_ID;
const CLIENT_ID      = process.env.BANDWIDTH_CLIENT_ID;
const CLIENT_SECRET  = process.env.BANDWIDTH_CLIENT_SECRET;
const NGROK_URL      = process.env.NGROK_URL;
const VOICE_APP_ID   = process.env.BANDWIDTH_VOICE_APPLICATION_ID;

const CALLER_NUMBER  = String(
    process.env.BANDWIDTH_VOICE_PATIENT_NUMBER ||
    process.env.BANDWIDTH_VOICE_FACILITY_NUMBER || ""
).trim();

if (!ACCOUNT_ID || !CLIENT_ID || !CLIENT_SECRET)
    throw new Error("Missing Bandwidth credentials in .env");
if (!NGROK_URL)
    throw new Error("Missing NGROK_URL in .env");
if (!VOICE_APP_ID || !CALLER_NUMBER)
    throw new Error("Missing BANDWIDTH_VOICE_APPLICATION_ID or BANDWIDTH_VOICE_PATIENT_NUMBER in .env");
if (!/^\+[1-9]\d{6,14}$/.test(CALLER_NUMBER))
    throw new Error(`CALLER_NUMBER "${CALLER_NUMBER}" is not E.164`);

/* ----------------------------------------
 * CONSTANTS
 * ---------------------------------------- */

const BRTC_API_URL          = "https://api.bandwidth.com/v2";
const VOICE_API_URL         = "https://voice.bandwidth.com/api/v2";
const OAUTH_URL             = "https://api.bandwidth.com/api/v1/oauth2/token";
const CALLBACK_URL          = `${NGROK_URL}/api/callbacks/bandwidth`;
const FALLBACK_CALLBACK_URL = `${NGROK_URL}/api/callbacks/bandwidth-fallback`;

const AFTER_CALL_MS  = 2500;
const DISCONNECT_MS  = 3000;
const HEARTBEAT_MS   = 25000;

/* ----------------------------------------
 * DOCTORS THE PATIENT CAN CALL
 * ---------------------------------------- */

const doctors = [
    { id: "DR001", name: process.env.BANDWIDTH_DOC_1_NAME || "Doctor 1", phoneNumber: String(process.env.BANDWIDTH_DOC_1_PHONE || "").trim() },
    { id: "DR002", name: process.env.BANDWIDTH_DOC_2_NAME || "Doctor 2", phoneNumber: String(process.env.BANDWIDTH_DOC_2_PHONE || "").trim() },
    { id: "DR003", name: process.env.BANDWIDTH_DOC_3_NAME || "Doctor 3", phoneNumber: String(process.env.BANDWIDTH_DOC_3_PHONE || "").trim() },
].filter(d => d.phoneNumber);

/* ----------------------------------------
 * SHARED STATE
 * ---------------------------------------- */

const brtcEndpointStatus  = new Map(); // endpointId → { eligible, token, … }
const doctorEndpointMap   = new Map(); // userId → endpointId
const doctorEventClients  = new Map(); // userId → Set(res)
const doctorCallState     = new Map(); // userId → { busyReason, activeCallId }

/* ----------------------------------------
 * SMALL HELPERS
 * ---------------------------------------- */

function safeJsonParse(v) {
    try { return v && typeof v === "string" ? JSON.parse(v) : null; } catch { return null; }
}

function xmlEscape(v) {
    return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
                    .replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

function sendBxml(res, verbs) {
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response>' + verbs + "</Response>");
}

/* ----------------------------------------
 * OAUTH
 * ---------------------------------------- */

async function getAccessToken() {
    const r = await axios.post(
        OAUTH_URL,
        new URLSearchParams({ grant_type: "client_credentials" }),
        { auth: { username: CLIENT_ID, password: CLIENT_SECRET },
          headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return r.data.access_token;
}

/* ----------------------------------------
 * BRTC ENDPOINT MANAGEMENT
 * ---------------------------------------- */

async function createEndpoint(userId) {
    console.log("Creating BRTC endpoint:", userId);
    const token = await getAccessToken();
    const r = await axios.post(
        `${BRTC_API_URL}/accounts/${ACCOUNT_ID}/endpoints`,
        {
            type: "WEBRTC", direction: "BIDIRECTIONAL",
            eventCallbackUrl: CALLBACK_URL, eventFallbackUrl: FALLBACK_CALLBACK_URL,
            tag: JSON.stringify({ environment: "poc", role: "patient", patientId: userId }),
        },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" } }
    );
    console.log("Endpoint response:", JSON.stringify(r.data, null, 2));
    return r.data.data;
}

async function deleteEndpoint(endpointId) {
    if (!endpointId) throw new Error("endpointId required");
    const forget = () => {
        brtcEndpointStatus.delete(endpointId);
        for (const [uid, eid] of doctorEndpointMap.entries()) {
            if (eid === endpointId) {
                doctorEndpointMap.delete(uid);
                console.log("Endpoint mapping removed:", uid, "→", endpointId);
            }
        }
        if (outboundModule) outboundModule.forgetEndpoint(endpointId);
    };
    const token = await getAccessToken();
    try {
        await axios.delete(`${BRTC_API_URL}/accounts/${ACCOUNT_ID}/endpoints/${endpointId}`,
            { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
        forget();
        console.log("BRTC endpoint deleted:", endpointId);
        return { success: true, endpointId };
    } catch (err) {
        if (err.response?.status === 404) { forget(); return { success: true, endpointId }; }
        throw err;
    }
}

function findUserByEndpoint(endpointId) {
    for (const [uid, eid] of doctorEndpointMap.entries()) if (eid === endpointId) return uid;
    return null;
}

/* ----------------------------------------
 * VOICE HELPERS
 * ---------------------------------------- */

async function endVoiceCall(callId) {
    const token = await getAccessToken();
    const r = await axios.post(`${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls/${callId}`,
        { state: "completed" },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    return r.data;
}

async function endVoiceCallSafe(callId) {
    if (!callId || String(callId).startsWith("test-")) return false;
    try {
        await endVoiceCall(callId);
        console.log("Voice call ended:", callId);
        return true;
    } catch (err) {
        const s = err.response?.status;
        if (s && s < 500) console.log("Voice call already ended:", callId, s);
        else console.error("Failed to end call:", callId, err.response?.data || err.message);
        return false;
    }
}

async function redirectVoiceCall(callId, redirectUrl) {
    const token = await getAccessToken();
    const r = await axios.post(`${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls/${callId}`,
        { redirectUrl },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    return r.data;
}

/* ----------------------------------------
 * USER STATE
 * ---------------------------------------- */

function isDoctorOnline(userId) {
    const eid = doctorEndpointMap.get(userId);
    if (!eid) return false;
    const s = brtcEndpointStatus.get(eid);
    if (!s || s.eligible !== true) return false;
    const c = doctorEventClients.get(userId);
    return Boolean(c && c.size);
}

function getDoctorCallState(userId) {
    if (!doctorCallState.has(userId)) doctorCallState.set(userId, { busyReason: null, activeCallId: null });
    return doctorCallState.get(userId);
}

function setDoctorBusy(userId, reason, callId) {
    const s = getDoctorCallState(userId);
    s.busyReason = reason; s.activeCallId = callId || null;
    console.log("Busy:", userId, "| reason:", reason, "| call:", callId || "-");
}

function markDoctorFree(userId, delayMs) {
    const s = getDoctorCallState(userId);
    s.busyReason = null; s.activeCallId = null;
    console.log("Free:", userId);
}

function sendDoctorEvent(userId, event) {
    const clients = doctorEventClients.get(userId);
    if (!clients || !clients.size) { console.log("No SSE client for:", userId); return false; }
    const msg = `data: ${JSON.stringify(event)}\n\n`;
    console.log(`SSE → ${userId}:`, JSON.stringify(event));
    for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
    return true;
}

/* ----------------------------------------
 * PICK USER TO RING (for inbound calls)
 * ---------------------------------------- */

function pickUserToRing() {
    const fixed = process.env.INCOMING_USER_ID;
    if (fixed) return fixed;
    for (const uid of doctorEndpointMap.keys()) if (isDoctorOnline(uid)) return uid;
    const first = doctorEndpointMap.keys().next();
    return first.done ? null : first.value;
}

/* ----------------------------------------
 * LOAD MODULES
 * ---------------------------------------- */

const ctx = {
    config: {
        NGROK_URL,
        ACCOUNT_ID,
        VOICE_API_URL,
        VOICE_APPLICATION_ID: VOICE_APP_ID,
        VOICE_FACILITY_NUMBER: CALLER_NUMBER,
        AFTER_CALL_DISPATCH_DELAY_MS: AFTER_CALL_MS,
        DISCONNECT_DISPATCH_DELAY_MS: DISCONNECT_MS,
        // aliases outbound.server.js destructures
        BANDWIDTH_ACCOUNT_ID:          ACCOUNT_ID,
        BANDWIDTH_VOICE_URL:           VOICE_API_URL,
        BANDWIDTH_VOICE_APPLICATION_ID: VOICE_APP_ID,
    },
    brtcEndpointStatus,
    doctorEndpointMap,
    doctorEventClients,
    patients: [],
    patientDoctorMap: new Map(),
    pickUserToRing,
    getPatientById:      function () { return null; },
    findPatientByPhone:  function () { return null; },
    getPatientIdFromPhone: function () { return null; },
    getAccessToken,
    endVoiceCall,
    endVoiceCallSafe,
    redirectVoiceCall,
    findDoctorByEndpoint: findUserByEndpoint,
    isDoctorOnline,
    getDoctorCallState,
    setDoctorBusy,
    markDoctorFree,
    sendDoctorEvent,
    safeJsonParse,
    xmlEscape,
    sendBxml,
    // No-op history stub so outbound.server.js doesn't crash
    history: {
        callStarted:    function () {},
        callUpdated:    function () {},
        callEnded:      function () {},
        recordingVerbs: function () { return ""; },
        RECORDING_NOTICE: null,
    },
    // No-op verification stub
    verification: {
        registerPurpose: function () {},
        start:           function () { return "<Hangup/>"; },
        handleDisconnect: function () { return false; },
    },
};

const OutboundCallHandler = require("./outbound.server");
const outboundModule = new OutboundCallHandler(app, ctx);
const inboundModule  = require("./inbound.server")(app, ctx);

/* ----------------------------------------
 * HEALTH
 * ---------------------------------------- */

app.get("/health", (req, res) => res.json({ success: true, message: "Patient Voice backend running" }));

/* ----------------------------------------
 * /api/login — alias used by the browser on page load
 *
 * Expects: { doctorId }
 * Returns: { doctor: { id, name }, endpointId, endpointToken }
 * ---------------------------------------- */

app.post("/api/login", async (req, res) => {
    const userId = req.body?.doctorId;
    if (!userId) return res.status(400).json({ success: false, error: "doctorId required" });

    console.log("Login:", userId);

    // Always create a fresh endpoint on login (delete the old one if present).
    try {
        const oldEid = doctorEndpointMap.get(userId);
        if (oldEid) {
            doctorEndpointMap.delete(userId);
            deleteEndpoint(oldEid).catch(() => {});
        }

        const ep = await createEndpoint(userId);

        brtcEndpointStatus.set(ep.endpointId, {
            eligible: false, deviceId: null, timestamp: Date.now(),
            token: ep.token, expirationTimestamp: ep.expirationTimestamp,
        });
        doctorEndpointMap.set(userId, ep.endpointId);

        const state = getDoctorCallState(userId);
        state.busyReason = null; state.activeCallId = null;

        console.log("Endpoint mapped:", userId, "→", ep.endpointId);

        res.json({
            success: true,
            doctor:        { id: userId, name: userId },
            endpointId:    ep.endpointId,
            endpointToken: ep.token,
            // also in legacy shapes the browser tries
            endpoint: { id: ep.endpointId, token: ep.token },
        });
    } catch (err) {
        console.error("Login error:", err.response?.data || err.message);
        res.status(err.response?.status || 500).json({ success: false, error: err.response?.data || err.message });
    }
});

/* ----------------------------------------
 * /api/doctors/:id/events — SSE alias used by the browser
 * ---------------------------------------- */

app.get("/api/doctors/:doctorId/events", (req, res) => {
    const userId = req.params.doctorId;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();

    if (!doctorEventClients.has(userId)) doctorEventClients.set(userId, new Set());
    const clients = doctorEventClients.get(userId);
    clients.add(res);

    console.log("SSE connected:", userId);
    res.write(`data: ${JSON.stringify({ type: "connected", doctorId: userId })}\n\n`);

    const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { clearInterval(hb); } }, HEARTBEAT_MS);

    req.on("close", () => {
        clearInterval(hb);
        clients.delete(res);
        console.log("SSE disconnected:", userId);
        if (!clients.size) doctorEventClients.delete(userId);
    });
});

/* ----------------------------------------
 * DOCTORS LIST (browser loads from /api/patients)
 * ---------------------------------------- */

app.get("/api/patients", (req, res) => {
    res.json({ success: true, patients: doctors.map(d => ({ id: d.id, name: d.name, phoneNumber: d.phoneNumber })) });
});

/* ----------------------------------------
 * LOGIN — create BRTC endpoint
 * ---------------------------------------- */

app.post("/api/doctor/session", async (req, res) => {
    const userId = req.body?.doctorId;
    if (!userId) return res.status(400).json({ success: false, message: "doctorId required" });

    console.log("Login:", userId);

    try {
        // If the user already has an eligible endpoint, reuse it.
        const existingEid = doctorEndpointMap.get(userId);
        if (existingEid) {
            const st = brtcEndpointStatus.get(existingEid);
            if (st?.eligible === true) {
                return res.json({ success: true, doctorId: userId, endpointId: existingEid, token: st.token, reused: true });
            }
            doctorEndpointMap.delete(userId);
        }

        const ep = await createEndpoint(userId);

        brtcEndpointStatus.set(ep.endpointId, {
            eligible: false, deviceId: null, timestamp: Date.now(),
            token: ep.token, expirationTimestamp: ep.expirationTimestamp,
        });
        doctorEndpointMap.set(userId, ep.endpointId);

        const state = getDoctorCallState(userId);
        state.busyReason = null; state.activeCallId = null;

        console.log("Endpoint mapped:", userId, "→", ep.endpointId);
        res.json({ success: true, doctorId: userId, endpointId: ep.endpointId, token: ep.token, reused: false });

    } catch (err) {
        console.error("Session error:", err.response?.data || err.message);
        res.status(err.response?.status || 500).json({ success: false, message: "Failed to create session", error: err.response?.data || err.message });
    }
});

/* ----------------------------------------
 * ENDPOINT CLEANUP (tab close / logout)
 * ---------------------------------------- */

app.post("/api/doctor/endpoint/cleanup", async (req, res) => {
    const endpointId = req.body?.endpointId;
    console.log("Cleanup:", endpointId);
    if (!endpointId) return res.status(400).json({ success: false, message: "endpointId required" });
    try { res.json(await deleteEndpoint(endpointId)); }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete("/api/doctor/endpoint/:endpointId", async (req, res) => {
    try { res.json(await deleteEndpoint(req.params.endpointId)); }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/* ----------------------------------------
 * ENDPOINT STATUS
 * ---------------------------------------- */

app.get("/api/doctor/endpoint-status", (req, res) => {
    const endpointId = req.query.endpointId;
    if (!endpointId) return res.status(400).json({ success: false, message: "endpointId required" });
    const s = brtcEndpointStatus.get(endpointId);
    res.json({ success: true, endpointId, eligible: s?.eligible === true, deviceId: s?.deviceId || null });
});

/* ----------------------------------------
 * IDLE (browser signals it finished a call)
 * ---------------------------------------- */

app.post("/api/doctor/idle", async (req, res) => {
    const userId = req.body?.doctorId;
    if (!userId) return res.status(400).json({ success: false, message: "doctorId required" });
    const state = getDoctorCallState(userId);
    if (state.activeCallId) await inboundModule.endActiveCall(state.activeCallId);
    markDoctorFree(userId, AFTER_CALL_MS);
    res.json({ success: true });
});

/* ----------------------------------------
 * DEBUG
 * ---------------------------------------- */

app.get("/api/doctors", (req, res) => {
    const users = Array.from(doctorEndpointMap.entries()).map(([uid, eid]) => {
        const s = brtcEndpointStatus.get(eid);
        const c = getDoctorCallState(uid);
        return { userId: uid, endpointId: eid, eligible: s?.eligible === true, online: isDoctorOnline(uid),
                 busyReason: c.busyReason, activeCallId: c.activeCallId };
    });
    res.json({ success: true, users });
});

/* ----------------------------------------
 * BRTC CALLBACKS
 * ---------------------------------------- */

app.post("/api/callbacks/bandwidth", async (req, res) => {
    console.log("Bandwidth callback:", JSON.stringify(req.body, null, 2));
    const event = req.body || {};

    if (event.event === "endpointEligible") {
        const existing = brtcEndpointStatus.get(event.endpointId) || {};
        brtcEndpointStatus.set(event.endpointId, { ...existing, eligible: true, deviceId: event.deviceId || null, timestamp: Date.now() });
        console.log("Endpoint ELIGIBLE:", event.endpointId);
        return res.sendStatus(200);
    }

    if (event.event === "endpointIneligible") {
        const existing = brtcEndpointStatus.get(event.endpointId) || {};
        brtcEndpointStatus.set(event.endpointId, { ...existing, eligible: false, deviceId: event.deviceId || null, timestamp: Date.now(),
            errorMessage: event.errorMessage || null, errorId: event.errorId || null });
        console.log("Endpoint INELIGIBLE:", event.endpointId, "|", event.errorMessage || "busy");

        if (event.errorId === "endpoint_disconnected") {
            // Recreate the endpoint so the user stays logged in.
            const userId = findUserByEndpoint(event.endpointId);
            if (userId) {
                console.log("Auto-recreating endpoint for:", userId);
                try {
                    const ep = await createEndpoint(userId);
                    brtcEndpointStatus.set(ep.endpointId, { eligible: false, deviceId: null, timestamp: Date.now(), token: ep.token });
                    doctorEndpointMap.set(userId, ep.endpointId);
                    sendDoctorEvent(userId, { type: "endpointRecreated", endpointId: ep.endpointId, token: ep.token });
                    console.log("Endpoint recreated:", ep.endpointId);
                } catch (err) {
                    console.error("Failed to recreate endpoint:", err.message);
                }
            }
        }

        return res.sendStatus(200);
    }

    if (event.event === "outboundConnectionRequest") {
        return outboundModule.handleOutboundConnectionRequest(event, res);
    }

    res.sendStatus(200);
});

app.post("/api/callbacks/bandwidth-fallback", (req, res) => {
    console.log("Bandwidth FALLBACK:", JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
});

/* ----------------------------------------
 * VOICE DISCONNECT (inbound + outbound)
 * ---------------------------------------- */

app.post("/api/callbacks/voice/disconnect", (req, res) => {
    console.log("Voice DISCONNECT:", JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
    const event = req.body || {};
    try {
        const inHandled  = inboundModule.handleDisconnect(event);
        const outHandled = outboundModule.handleDisconnect(event);
        if (!inHandled && !outHandled) console.log("Disconnect for untracked call:", event.callId);
    } catch (err) {
        console.error("Disconnect error:", err.message);
    }
});

/* ----------------------------------------
 * SSE
 * ---------------------------------------- */

app.get("/api/doctor/events", (req, res) => {
    const userId = req.query.doctorId;
    if (!userId) return res.status(400).json({ success: false, message: "doctorId required" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();

    if (!doctorEventClients.has(userId)) doctorEventClients.set(userId, new Set());
    const clients = doctorEventClients.get(userId);
    clients.add(res);

    console.log("SSE connected:", userId);
    res.write(`data: ${JSON.stringify({ type: "connected", doctorId: userId })}\n\n`);

    const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { clearInterval(hb); } }, HEARTBEAT_MS);

    req.on("close", () => {
        clearInterval(hb);
        clients.delete(res);
        console.log("SSE disconnected:", userId);
        if (!clients.size) doctorEventClients.delete(userId);
    });
});

/* ----------------------------------------
 * START
 * ---------------------------------------- */

app.listen(PORT, () => {
    console.log("==================================================");
    console.log("PATIENT VOICE BACKEND");
    console.log("==================================================");
    console.log("Port:      ", PORT);
    console.log("Public URL:", NGROK_URL);
    console.log("Caller ID: ", CALLER_NUMBER);
    console.log("Doctors:   ", doctors.map(d => `${d.name} ${d.phoneNumber}`).join(", ") || "(none)");
    console.log("==================================================");
});