/*
 * ========================================
 * PATIENT BACKEND (copy of the working doctor flow)
 * ========================================
 *
 * server.js           → config, OAuth, Bandwidth API helpers, shared state,
 *                        login / BRTC endpoints, SSE, busy state,
 *                        shared webhooks (endpoint events, disconnect)
 * outbound.server.js  → patient calls a doctor's phone number   (UNCHANGED)
 * inbound.server.js   → someone calls the patient's number       (UNCHANGED)
 *
 * Changes vs the doctor project (only in this file):
 *   - NO caller verification (verification.server.js is not used)
 *   - caller ID = BANDWIDTH_VOICE_PATIENT_NUMBER
 *   - call list = doctors from BANDWIDTH_DOC_1_PHONE / BANDWIDTH_DOC_2_PHONE
 *   - incoming calls ring the logged-in patient
 *
 * NOTE: the logged-in user is still called "doctor" inside the code
 * (doctorId, doctorEndpointMap, /api/doctor/...) because the unchanged
 * inbound/outbound modules and browser mixins use those names.
 * Here that user is the PATIENT.
 *
 * Bandwidth dashboard (Voice application):
 *   Call Initiated URL : {NGROK_URL}/api/callbacks/voice/answer
 *                        (or /api/callbacks/voice/initiate — both work)
 *   Call Status URL    : {NGROK_URL}/api/callbacks/voice/disconnect
 */

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const path = require("path");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "../public")));

const PORT = process.env.PORT || 4000;

const ACCOUNT_ID = process.env.BANDWIDTH_ACCOUNT_ID;
const CLIENT_ID = process.env.BANDWIDTH_CLIENT_ID;
const CLIENT_SECRET = process.env.BANDWIDTH_CLIENT_SECRET;

if (!ACCOUNT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing Bandwidth credentials in .env");
}

/* ----------------------------------------
 * BANDWIDTH API
 * ---------------------------------------- */

const BANDWIDTH_API_URL = "https://api.bandwidth.com";
const BRTC_ENDPOINT_API_URL = "https://api.bandwidth.com/v2";
const OAUTH_URL = `${BANDWIDTH_API_URL}/api/v1/oauth2/token`;

/* ----------------------------------------
 * NGROK CALLBACK URLS
 * ---------------------------------------- */

const NGROK_URL = process.env.NGROK_URL;

if (!NGROK_URL) {
    throw new Error("Missing NGROK_URL in .env");
}

const CALLBACK_URL = `${NGROK_URL}/api/callbacks/bandwidth`;
const FALLBACK_CALLBACK_URL = `${NGROK_URL}/api/callbacks/bandwidth-fallback`;

/* ----------------------------------------
 * BANDWIDTH VOICE API
 * ---------------------------------------- */

const VOICE_API_URL = "https://voice.bandwidth.com/api/v2";
const VOICE_APPLICATION_ID = process.env.BANDWIDTH_VOICE_APPLICATION_ID;

/*
 * Caller ID for outbound calls = the patient's Bandwidth number.
 * (outbound.server.js reads it as VOICE_FACILITY_NUMBER.)
 */

const VOICE_CALLER_NUMBER = String(
    process.env.BANDWIDTH_VOICE_PATIENT_NUMBER ||
        process.env.BANDWIDTH_VOICE_FACILITY_NUMBER ||
        "",
).trim();

if (!VOICE_APPLICATION_ID || !VOICE_CALLER_NUMBER) {
    throw new Error(
        "Missing BANDWIDTH_VOICE_APPLICATION_ID or BANDWIDTH_VOICE_PATIENT_NUMBER in .env",
    );
}

if (!/^\+[1-9]\d{6,14}$/.test(VOICE_CALLER_NUMBER)) {
    throw new Error(
        `BANDWIDTH_VOICE_PATIENT_NUMBER "${VOICE_CALLER_NUMBER}" is not E.164 (e.g. +12013507115).`,
    );
}

/* ----------------------------------------
 * TIMING
 * ---------------------------------------- */

const AFTER_CALL_DISPATCH_DELAY_MS = 2500; // let the browser finish cleanup first
const DISCONNECT_DISPATCH_DELAY_MS = 3000;
const SSE_HEARTBEAT_MS = 25000;

/* ----------------------------------------
 * SHARED STATE
 * ---------------------------------------- */

const brtcEndpointStatus = new Map(); // endpointId → { eligible, token, ... }
const doctorEndpointMap = new Map(); // userId (patient) → endpointId
const doctorEventClients = new Map(); // userId (patient) → Set(res)

/*
 * userId → { busyReason, activeCallId }
 *
 * busyReason: null | "outbound" | "inbound" | "browser"
 * activeCallId: connected inbound PSTN call id
 */

const doctorCallState = new Map();

/* ----------------------------------------
 * DOCTORS THE PATIENT CAN CALL
 *
 * Shown in the browser list (GET /api/patients returns this list,
 * because the unchanged outbound.code.js loads from that route).
 * ---------------------------------------- */

const doctors = [
    {
        id: "DR001",
        name: process.env.BANDWIDTH_DOC_1_NAME || "Doctor 1",
        phoneNumber: String(process.env.BANDWIDTH_DOC_1_PHONE || "").trim(),
    },
    {
        id: "DR002",
        name: process.env.BANDWIDTH_DOC_2_NAME || "Doctor 2",
        phoneNumber: String(process.env.BANDWIDTH_DOC_2_PHONE || "").trim(),
    },
    {
        id: "DR003",
        name: process.env.BANDWIDTH_DOC_3_NAME || "Doctor 3",
        phoneNumber: String(process.env.BANDWIDTH_DOC_3_PHONE || "").trim(),
    },
].filter(function (doctor) {
    return doctor.phoneNumber;
});

/*
 * No verification → no patient directory.
 *
 * inbound.server.js uses patientDoctorMap to find WHO to ring.
 * The no-verification module (below) fills it in for every
 * incoming call with the logged-in patient.
 */

const patients = [];

const patientDoctorMap = new Map();

function getPatientById() {
    return null;
}

// null → outbound.server.js connects the answered call directly (no DOB).
function findPatientByPhone() {
    return null;
}

function getPatientIdFromPhone() {
    return null;
}

/* ----------------------------------------
 * SMALL HELPERS
 * ---------------------------------------- */

function safeJsonParse(value) {
    if (!value || typeof value !== "string") return null;

    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
}

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function sendBxml(res, verbs) {
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(
        '<?xml version="1.0" encoding="UTF-8"?><Response>' +
            verbs +
            "</Response>",
    );
}

/* ----------------------------------------
 * OAUTH ACCESS TOKEN
 * ---------------------------------------- */

async function getAccessToken() {
    const response = await axios.post(
        OAUTH_URL,
        new URLSearchParams({ grant_type: "client_credentials" }),
        {
            auth: {
                username: CLIENT_ID,
                password: CLIENT_SECRET,
            },
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
        },
    );

    return response.data.access_token;
}

/* ----------------------------------------
 * BRTC ENDPOINTS
 * ---------------------------------------- */

async function createDoctorEndpoint(userId) {
    console.log("Creating new patient BRTC endpoint:", userId);

    const accessToken = await getAccessToken();

    const response = await axios.post(
        `${BRTC_ENDPOINT_API_URL}/accounts/${ACCOUNT_ID}/endpoints`,
        {
            type: "WEBRTC",
            direction: "BIDIRECTIONAL",
            eventCallbackUrl: CALLBACK_URL,
            eventFallbackUrl: FALLBACK_CALLBACK_URL,
            tag: JSON.stringify({
                environment: "poc",
                role: "patient",
                patientId: userId,
            }),
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
        },
    );

    console.log("Endpoint response:", JSON.stringify(response.data, null, 2));

    return response.data.data;
}

function findDoctorByEndpoint(endpointId) {
    for (const [userId, mappedEndpointId] of doctorEndpointMap.entries()) {
        if (mappedEndpointId === endpointId) return userId;
    }

    return null;
}

function removeDoctorEndpointMapping(endpointId) {
    for (const [userId, mappedEndpointId] of doctorEndpointMap.entries()) {
        if (mappedEndpointId === endpointId) {
            doctorEndpointMap.delete(userId);

            console.log(
                "Patient endpoint mapping removed:",
                userId,
                "→",
                endpointId,
            );
        }
    }
}

async function deleteDoctorEndpoint(endpointId) {
    if (!endpointId) {
        throw new Error("endpointId is required");
    }

    const forget = function () {
        brtcEndpointStatus.delete(endpointId);
        removeDoctorEndpointMapping(endpointId);

        if (outboundModule) outboundModule.forgetEndpoint(endpointId);
    };

    const accessToken = await getAccessToken();

    try {
        const response = await axios.delete(
            `${BRTC_ENDPOINT_API_URL}/accounts/${ACCOUNT_ID}/endpoints/${endpointId}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/json",
                },
            },
        );

        forget();

        console.log("BRTC endpoint deleted:", endpointId);

        return { success: true, endpointId: endpointId, data: response.data };
    } catch (error) {
        if (error.response?.status === 404) {
            forget();

            console.log("BRTC endpoint was already deleted:", endpointId);

            return {
                success: true,
                endpointId: endpointId,
                message: "Endpoint was already deleted.",
            };
        }

        throw error;
    }
}

/* ----------------------------------------
 * VOICE API HELPERS
 * ---------------------------------------- */

async function endVoiceCall(callId) {
    const accessToken = await getAccessToken();

    const response = await axios.post(
        `${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls/${callId}`,
        { state: "completed" },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        },
    );

    return response.data;
}

/*
 * Same as endVoiceCall, but a call that is already gone is not an error.
 */

async function endVoiceCallSafe(callId) {
    if (!callId || String(callId).startsWith("test-")) return false;

    try {
        await endVoiceCall(callId);

        console.log("Voice call ended:", callId);

        return true;
    } catch (error) {
        const status = error.response?.status;

        if (status && status < 500) {
            console.log(
                "Voice call already ended:",
                callId,
                "| status:",
                status,
            );
        } else {
            console.error(
                "Failed to end Voice call:",
                callId,
                error.response?.data || error.message,
            );
        }

        return false;
    }
}

async function redirectVoiceCall(callId, redirectUrl) {
    const accessToken = await getAccessToken();

    const response = await axios.post(
        `${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls/${callId}`,
        { redirectUrl: redirectUrl },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        },
    );

    return response.data;
}

/* ----------------------------------------
 * ONLINE / BUSY STATE (of the logged-in patient)
 * ---------------------------------------- */

function isDoctorOnline(userId) {
    const endpointId = doctorEndpointMap.get(userId);
    if (!endpointId) return false;

    const status = brtcEndpointStatus.get(endpointId);
    if (!status || status.eligible !== true) return false;

    const clients = doctorEventClients.get(userId);
    return Boolean(clients && clients.size);
}

function getDoctorCallState(userId) {
    if (!doctorCallState.has(userId)) {
        doctorCallState.set(userId, { busyReason: null, activeCallId: null });
    }

    return doctorCallState.get(userId);
}

function setDoctorBusy(userId, reason, callId) {
    const state = getDoctorCallState(userId);

    state.busyReason = reason;
    state.activeCallId = callId || null;

    console.log(
        "Patient busy:",
        userId,
        "| reason:",
        reason,
        "| call:",
        callId || "-",
    );
}

/*
 * Free → after a short delay, ring the next queued caller.
 */

function markDoctorFree(userId, delayMs) {
    const state = getDoctorCallState(userId);

    state.busyReason = null;
    state.activeCallId = null;

    console.log("Patient free:", userId);

    setTimeout(function () {
        if (inboundModule) inboundModule.dispatchNext(userId);
    }, delayMs || 0);
}

/* ----------------------------------------
 * SEND SSE EVENT TO THE BROWSER
 * ---------------------------------------- */

function sendDoctorEvent(userId, event) {
    const clients = doctorEventClients.get(userId);

    if (!clients || !clients.size) {
        console.log("No SSE client connected for:", userId);

        return false;
    }

    const message = `data: ${JSON.stringify(event)}\n\n`;

    console.log(`SSE → ${userId}:`, JSON.stringify(event));

    for (const client of clients) {
        try {
            client.write(message);
        } catch (error) {
            console.error("Failed to send SSE event:", error.message);

            clients.delete(client);
        }
    }

    return true;
}

/* ----------------------------------------
 * NO VERIFICATION
 *
 * Replaces verification.server.js with the same interface
 * (start / registerPurpose / handleDisconnect), so the unchanged
 * inbound.server.js and outbound.server.js keep working.
 *
 * start() skips DOB / name and goes straight to "verified".
 * ---------------------------------------- */

const INCOMING_CALLER_KEY = "INCOMING_CALLER";

// Optional: always ring this user for incoming calls (e.g. PT001).
const INCOMING_USER_ID = process.env.INCOMING_USER_ID || null;

function pickUserToRing() {
    if (INCOMING_USER_ID) return INCOMING_USER_ID;

    for (const userId of doctorEndpointMap.keys()) {
        if (isDoctorOnline(userId)) return userId;
    }

    // Nobody online → first logged-in user (inbound.server.js then says "unavailable").
    const first = doctorEndpointMap.keys().next();

    return first.done ? null : first.value;
}

function createNoVerification() {
    const purposes = {};

    return {
        registerPurpose: function (purpose, handlers) {
            purposes[purpose] = handlers;
        },

        start: function (callId, options) {
            const handlers = purposes[options.purpose];

            if (!handlers) {
                console.error("No handler for purpose:", options.purpose);

                return "<Hangup/>";
            }

            if (options.purpose === "inbound") {
                const userId = pickUserToRing();

                if (userId) {
                    patientDoctorMap.set(INCOMING_CALLER_KEY, userId);
                } else {
                    patientDoctorMap.delete(INCOMING_CALLER_KEY);
                }

                console.log("No verification (inbound) → ringing:", userId || "NOBODY");
            } else {
                console.log("No verification (" + options.purpose + "):", callId);
            }

            return handlers.onVerified(
                {
                    callId: callId,
                    purpose: options.purpose,
                    from: options.from || null,
                    to: options.to || null,
                    data: options.data || {},
                },
                {
                    verified: true,
                    method: "none",
                    patientId: options.expectedPatientId || INCOMING_CALLER_KEY,
                    heardFirstName: "",
                    heardLastName: "",
                },
            );
        },

        handleDisconnect: function () {
            return false;
        },
    };
}

/* ----------------------------------------
 * INCOMING CALLS SENT TO /voice/answer
 *
 * The dashboard "Call initiated" URL is /api/callbacks/voice/answer,
 * but in this code incoming calls are handled by /voice/initiate
 * (/voice/answer is the OUTBOUND answer route in outbound.server.js).
 *
 * Bandwidth marks incoming calls with eventType "initiate", so they
 * are forwarded to /voice/initiate here. Must be registered BEFORE
 * the modules below.
 * ---------------------------------------- */

app.post("/api/callbacks/voice/answer", function (req, res, next) {
    const event = req.body || {};

    if (event.eventType !== "initiate") {
        return next(); // outbound "answer" → outbound.server.js
    }

    // Ignore calls for another account / Voice Application.
    if (
        (event.accountId && String(event.accountId) !== String(ACCOUNT_ID)) ||
        (event.applicationId && event.applicationId !== VOICE_APPLICATION_ID)
    ) {
        console.warn(
            "Ignoring incoming call from another account/application:",
            event.accountId,
            event.applicationId,
            "| to:",
            event.to,
        );

        return sendBxml(res, "<Hangup/>");
    }

    console.log("Incoming call on /voice/answer → forwarding to /voice/initiate");

    req.url = "/api/callbacks/voice/initiate";

    next();
});

/* ----------------------------------------
 * LOAD OUTBOUND + INBOUND MODULES (UNCHANGED FILES)
 * ---------------------------------------- */

const ctx = {
    config: {
        NGROK_URL,
        ACCOUNT_ID,
        VOICE_API_URL,
        VOICE_APPLICATION_ID,
        VOICE_FACILITY_NUMBER: VOICE_CALLER_NUMBER, // caller ID for outbound calls
        AFTER_CALL_DISPATCH_DELAY_MS,
        DISCONNECT_DISPATCH_DELAY_MS,
    },
    brtcEndpointStatus,
    doctorEndpointMap,
    doctorEventClients,
    patients,
    patientDoctorMap,
    getPatientById,
    findPatientByPhone,
    getAccessToken,
    endVoiceCall,
    endVoiceCallSafe,
    redirectVoiceCall,
    getPatientIdFromPhone,
    findDoctorByEndpoint,
    isDoctorOnline,
    getDoctorCallState,
    setDoctorBusy,
    markDoctorFree,
    sendDoctorEvent,
    safeJsonParse,
    xmlEscape,
    sendBxml,
};

// No DOB / name verification in the patient flow.
const verificationModule = createNoVerification();
ctx.verification = verificationModule;

const outboundModule = require("./outbound.server")(app, ctx);
const inboundModule = require("./inbound.server")(app, ctx);

/* ----------------------------------------
 * HEALTH CHECK
 * ---------------------------------------- */

app.get("/health", (req, res) => {
    res.json({
        success: true,
        message: "Patient Voice backend is running",
    });
});

/* ----------------------------------------
 * CALL LIST FOR THE BROWSER = DOCTORS
 * (route name kept for the unchanged outbound.code.js)
 * ---------------------------------------- */

app.get("/api/patients", (req, res) => {
    res.json({
        success: true,
        patients: doctors.map(function (doctor) {
            return {
                id: doctor.id,
                name: doctor.name,
                phoneNumber: doctor.phoneNumber,
            };
        }),
    });
});

/* ----------------------------------------
 * TEST BANDWIDTH AUTH
 * ---------------------------------------- */

app.get("/api/test-auth", async (req, res) => {
    try {
        await getAccessToken();

        res.json({
            success: true,
            message: "Bandwidth OAuth authentication successful",
        });
    } catch (error) {
        console.error("OAuth error:", error.response?.data || error.message);

        res.status(500).json({
            success: false,
            message: "Bandwidth OAuth authentication failed",
            error: error.response?.data || error.message,
        });
    }
});

/* ----------------------------------------
 * CREATE SESSION (patient login)
 * ---------------------------------------- */

app.post("/api/doctor/session", async (req, res) => {
    const userId = req.body?.doctorId;

    if (!userId) {
        return res.status(400).json({
            success: false,
            message: "patient id is required",
        });
    }

    console.log("Starting patient session:", userId);

    try {
        const oldEndpointId = doctorEndpointMap.get(userId);

        if (oldEndpointId) {
            const oldStatus = brtcEndpointStatus.get(oldEndpointId);

            if (oldStatus?.eligible === true) {
                console.log(
                    "Patient already has an active eligible endpoint:",
                    oldEndpointId,
                );

                return res.json({
                    success: true,
                    doctorId: userId,
                    endpointId: oldEndpointId,
                    token: oldStatus.token || null,
                    expirationTimestamp: oldStatus.expirationTimestamp || null,
                    reused: true,
                });
            }

            doctorEndpointMap.delete(userId);
        }

        const endpoint = await createDoctorEndpoint(userId);

        brtcEndpointStatus.set(endpoint.endpointId, {
            eligible: false,
            deviceId: null,
            timestamp: Date.now(),
            token: endpoint.token,
            expirationTimestamp: endpoint.expirationTimestamp,
        });

        doctorEndpointMap.set(userId, endpoint.endpointId);

        // Fresh login → not on any call.
        const state = getDoctorCallState(userId);
        state.busyReason = null;
        state.activeCallId = null;

        console.log("Patient endpoint mapping:", userId, "→", endpoint.endpointId);

        res.json({
            success: true,
            doctorId: userId,
            endpointId: endpoint.endpointId,
            token: endpoint.token,
            expirationTimestamp: endpoint.expirationTimestamp,
            reused: false,
        });
    } catch (error) {
        console.error(
            "BRTC endpoint creation error:",
            error.response?.data || error.message,
        );

        res.status(error.response?.status || 500).json({
            success: false,
            message: "Failed to create patient BRTC session",
            error: error.response?.data || error.message,
        });
    }
});

/* ----------------------------------------
 * ACTIVE USERS (debugging)
 * ---------------------------------------- */

app.get("/api/doctors", (req, res) => {
    const users = Array.from(doctorEndpointMap.entries()).map(
        ([userId, endpointId]) => {
            const status = brtcEndpointStatus.get(endpointId);
            const callState = getDoctorCallState(userId);

            return {
                userId: userId,
                endpointId: endpointId,
                eligible: status?.eligible === true,
                online: isDoctorOnline(userId),
                busyReason: callState.busyReason,
                activeCallId: callState.activeCallId,
                deviceId: status?.deviceId || null,
                timestamp: status?.timestamp || null,
                expirationTimestamp: status?.expirationTimestamp || null,
            };
        },
    );

    res.json({ success: true, users: users });
});

/* ----------------------------------------
 * DELETE BRTC ENDPOINT
 * ---------------------------------------- */

app.delete("/api/doctor/endpoint/:endpointId", async (req, res) => {
    const endpointId = req.params.endpointId;

    console.log("Delete patient BRTC endpoint:", endpointId);

    try {
        res.json(await deleteDoctorEndpoint(endpointId));
    } catch (error) {
        console.error(
            "BRTC endpoint deletion error:",
            error.response?.data || error.message,
        );

        res.status(error.response?.status || 500).json({
            success: false,
            message: "Failed to delete BRTC endpoint",
            error: error.response?.data || error.message,
        });
    }
});

/* ----------------------------------------
 * BRTC ENDPOINT CLEANUP (tab close beacon)
 * ---------------------------------------- */

app.post("/api/doctor/endpoint/cleanup", async (req, res) => {
    const endpointId = req.body?.endpointId;

    console.log("BRTC endpoint cleanup request:", endpointId);

    if (!endpointId) {
        return res.status(400).json({
            success: false,
            message: "endpointId is required",
        });
    }

    try {
        res.json(await deleteDoctorEndpoint(endpointId));
    } catch (error) {
        console.error(
            "BRTC endpoint cleanup error:",
            error.response?.data || error.message,
        );

        res.status(error.response?.status || 500).json({
            success: false,
            message: "Failed to cleanup BRTC endpoint",
            error: error.response?.data || error.message,
        });
    }
});

/* ----------------------------------------
 * BRTC ENDPOINT STATUS
 * ---------------------------------------- */

app.get("/api/doctor/endpoint-status", (req, res) => {
    const endpointId = req.query.endpointId;

    if (!endpointId) {
        return res.status(400).json({
            success: false,
            message: "endpointId is required",
        });
    }

    const status = brtcEndpointStatus.get(endpointId);

    res.json({
        success: true,
        endpointId: endpointId,
        eligible: status?.eligible === true,
        deviceId: status?.deviceId || null,
        timestamp: status?.timestamp || null,
        expirationTimestamp: status?.expirationTimestamp || null,
    });
});

/* ----------------------------------------
 * IDLE (browser finished any call)
 * ---------------------------------------- */

app.post("/api/doctor/idle", async (req, res) => {
    const userId = req.body?.doctorId;
    const pstnCallId = req.body?.pstnCallId || null;

    if (!userId) {
        return res.status(400).json({
            success: false,
            message: "patient id is required",
        });
    }

    const state = getDoctorCallState(userId);

    /*
     * Server thinks the patient is on a DIFFERENT inbound call
     * → this is a late message from an older call. Ignore it.
     */

    if (state.activeCallId && state.activeCallId !== pstnCallId) {
        console.log("Stale idle ignored:", userId, "| active:", state.activeCallId);

        return res.json({ success: true, ignored: true });
    }

    // Browser ended this call → make sure the phone leg is closed too.
    if (state.activeCallId) {
        await inboundModule.endActiveCall(state.activeCallId);
    }

    markDoctorFree(userId, AFTER_CALL_DISPATCH_DELAY_MS);

    res.json({ success: true });
});

/* ----------------------------------------
 * TEST CALLBACK
 * ---------------------------------------- */

app.get("/api/callbacks/test", (req, res) => {
    res.json({
        success: true,
        message: "Bandwidth callback endpoint is reachable",
    });
});

/* ----------------------------------------
 * BRTC CALLBACK (shared)
 *
 * endpointEligible / endpointIneligible → common
 * outboundConnectionRequest             → outbound.server.js
 * ---------------------------------------- */

app.post("/api/callbacks/bandwidth", async (req, res) => {
    console.log(
        "Bandwidth callback received:",
        JSON.stringify(req.body, null, 2),
    );

    const event = req.body || {};

    if (event.endpointId && event.event === "endpointEligible") {
        const existingStatus = brtcEndpointStatus.get(event.endpointId) || {};

        brtcEndpointStatus.set(event.endpointId, {
            ...existingStatus,
            eligible: true,
            deviceId: event.deviceId || null,
            timestamp: Date.now(),
        });

        console.log("BRTC endpoint is ELIGIBLE:", event.endpointId);

        // Callers may be waiting for this patient.
        const userId = findDoctorByEndpoint(event.endpointId);

        if (userId) {
            setTimeout(function () {
                inboundModule.dispatchNext(userId);
            }, 1000);
        }

        return res.sendStatus(200);
    }

    if (event.endpointId && event.event === "endpointIneligible") {
        const existingStatus = brtcEndpointStatus.get(event.endpointId) || {};

        brtcEndpointStatus.set(event.endpointId, {
            ...existingStatus,
            eligible: false,
            deviceId: event.deviceId || null,
            timestamp: Date.now(),
            errorMessage: event.errorMessage || null,
            errorId: event.errorId || null,
        });

        /*
         * Mapping is kept on purpose: the endpoint becomes eligible
         * again after a call. It is removed when the endpoint is deleted.
         */

        console.log("BRTC endpoint is INELIGIBLE:", event.endpointId);
        console.log("Reason:", event.errorMessage || "busy (in a call)");

        return res.sendStatus(200);
    }

    if (event.event === "outboundConnectionRequest") {
        return outboundModule.handleOutboundConnectionRequest(event, res);
    }

    res.sendStatus(200);
});

/* ----------------------------------------
 * BRTC CALLBACK FALLBACK
 * ---------------------------------------- */

app.post("/api/callbacks/bandwidth-fallback", (req, res) => {
    console.log(
        "Bandwidth FALLBACK callback received:",
        JSON.stringify(req.body, null, 2),
    );

    res.sendStatus(200);
});

/* ----------------------------------------
 * VOICE DISCONNECT (shared)
 *
 * Fires for BOTH inbound and outbound calls.
 * ---------------------------------------- */

app.post("/api/callbacks/voice/disconnect", (req, res) => {
    console.log(
        "Bandwidth Voice DISCONNECT:",
        JSON.stringify(req.body, null, 2),
    );

    const event = req.body || {};

    try {
        const wasVerifying = verificationModule.handleDisconnect(event);

        const handled =
            inboundModule.handleDisconnect(event) ||
            outboundModule.handleDisconnect(event) ||
            wasVerifying;

        if (!handled) {
            console.log("Disconnect for untracked call:", event.callId);
        }
    } catch (error) {
        console.error("Disconnect handling error:", error.message);
    }

    res.sendStatus(200);
});

/* ----------------------------------------
 * SSE (browser events)
 * ---------------------------------------- */

app.get("/api/doctor/events", (req, res) => {
    const userId = req.query.doctorId;

    if (!userId) {
        return res.status(400).json({
            success: false,
            message: "patient id is required",
        });
    }

    console.log("SSE connected:", userId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    if (res.flushHeaders) {
        res.flushHeaders();
    }

    if (!doctorEventClients.has(userId)) {
        doctorEventClients.set(userId, new Set());
    }

    const clients = doctorEventClients.get(userId);

    clients.add(res);

    res.write(
        `data: ${JSON.stringify({ type: "connected", doctorId: userId })}\n\n`,
    );

    // Show the current waiting list right away.
    inboundModule.broadcastQueue(userId);

    // Keep idle connections from being dropped.
    const heartbeat = setInterval(function () {
        try {
            res.write(": ping\n\n");
        } catch (error) {
            clearInterval(heartbeat);
        }
    }, SSE_HEARTBEAT_MS);

    req.on("close", () => {
        clearInterval(heartbeat);

        clients.delete(res);

        console.log("SSE disconnected:", userId);

        if (!clients.size) {
            doctorEventClients.delete(userId);
        }
    });
});

/* ----------------------------------------
 * START SERVER
 * ---------------------------------------- */

app.listen(PORT, () => {
    console.log("==================================================");
    console.log("PATIENT VOICE BACKEND (no verification)");
    console.log("==================================================");
    console.log("Port:        ", PORT);
    console.log("Public URL:  ", NGROK_URL);
    console.log("Caller ID:   ", VOICE_CALLER_NUMBER);
    console.log(
        "Doctors:     ",
        doctors.map((d) => `${d.name} ${d.phoneNumber}`).join(", ") || "(none — set BANDWIDTH_DOC_1_PHONE)",
    );
    console.log("");
    console.log("Dashboard → Call initiated:", `${NGROK_URL}/api/callbacks/voice/answer`);
    console.log("Dashboard → Call status:   ", `${NGROK_URL}/api/callbacks/voice/disconnect`);
    console.log("==================================================");
});